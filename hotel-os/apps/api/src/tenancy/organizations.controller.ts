import { Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { type Db, schema, withTenant } from "@hotel-os/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AccessService } from "../auth/access.service";
import { AdminGuard } from "../auth/admin.guard";
import { AuthService } from "../auth/auth.service";
import { CurrentPrincipal, type Principal } from "../auth/principal";
import { AuditService } from "../common/audit.service";
import { DB } from "../common/db.module";
import { parse, uuidParam } from "../common/validation";

const CreateOrg = z.object({
  name: z.string().min(1).max(200),
  partnerId: z.string().uuid().optional(),
  plan: z.string().default("essentials"),
  modules: z.array(z.string().regex(/^[a-z_]+$/)).default([]),
  maxRooms: z.number().int().positive().optional(),
});
const CreateUser = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  /** Temporary password; TOTP enrolment is forced at first login. */
  password: z.string().min(12).max(200),
  role: z.enum(["ORG_ADMIN", "HOTEL_ADMIN", "MANAGER", "TECHNICIAN", "READ_ONLY"]),
  hotelId: z.string().uuid().nullable().default(null),
});

@Controller("v1/organizations")
@UseGuards(AdminGuard)
export class OrganizationsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  async create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    if (!p.isPlatformAdmin) throw new ForbiddenException({ code: "PLATFORM_ONLY" });
    const b = parse(CreateOrg, body);
    return withTenant(this.db, this.access.ctxFor(p), async (tx) => {
      const [org] = await tx.insert(schema.organizations).values({ name: b.name, partnerId: b.partnerId }).returning();
      await tx.insert(schema.subscriptions).values({ organizationId: org.id, plan: b.plan, modules: b.modules, maxRooms: b.maxRooms });
      await this.audit.log(tx, { organizationId: org.id, actorType: "USER", actorId: p.userId, action: "org.create", targetType: "ORG", targetId: org.id, data: b, ip: p.ip });
      return org;
    });
  }

  @Get()
  list(@CurrentPrincipal() p: Principal) {
    return withTenant(this.db, this.access.ctxFor(p), (tx) => tx.select().from(schema.organizations).orderBy(schema.organizations.name));
  }

  @Post(":id/users")
  async createUser(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body() body: unknown) {
    const orgId = uuidParam(id);
    const b = parse(CreateUser, body);
    // Hotel-scoped admins can only create users for their own hotel(s).
    if (!this.access.can(p, "user:manage", orgId, b.hotelId)) throw new ForbiddenException({ code: "FORBIDDEN", permission: "user:manage" });
    if (b.role === "ORG_ADMIN" && !this.access.can(p, "user:manage", orgId, null)) throw new ForbiddenException({ code: "FORBIDDEN" });
    const passwordHash = await AuthService.hashPassword(b.password);
    return withTenant(this.db, { orgIds: [orgId], platform: false }, async (tx) => {
      if (b.hotelId) {
        const [h] = await tx.select().from(schema.hotels).where(eq(schema.hotels.id, b.hotelId));
        if (!h) throw new ForbiddenException({ code: "HOTEL_NOT_IN_ORG" });
      }
      const email = b.email.toLowerCase();
      let [user] = await tx.select().from(schema.users).where(eq(schema.users.email, email));
      if (!user) [user] = await tx.insert(schema.users).values({ email, name: b.name, passwordHash }).returning();
      else if (user.isPlatformAdmin) throw new ConflictException({ code: "USER_IS_PLATFORM_ADMIN" });
      const [m] = await tx.insert(schema.memberships).values({ userId: user.id, organizationId: orgId, hotelId: b.hotelId, role: b.role }).returning();
      await this.audit.log(tx, { organizationId: orgId, actorType: "USER", actorId: p.userId, action: "user.add_membership", targetType: "USER", targetId: user.id, data: { role: b.role, hotelId: b.hotelId }, ip: p.ip });
      return { userId: user.id, membershipId: m.id };
    });
  }
}
