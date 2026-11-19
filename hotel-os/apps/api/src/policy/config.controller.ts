import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Put, UseGuards } from "@nestjs/common";
import { type Db, schema, withTenant } from "@hotel-os/db";
import { PolicyConfigSchema } from "@hotel-os/policy-engine";
import { ScopeType } from "@hotel-os/protocol";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AccessService } from "../auth/access.service";
import { AdminGuard } from "../auth/admin.guard";
import { CurrentPrincipal, type Principal } from "../auth/principal";
import type { Permission } from "../auth/rbac";
import { AuditService } from "../common/audit.service";
import { DB } from "../common/db.module";
import { parse, uuidParam } from "../common/validation";
import { PolicyService } from "./policy.service";

const PutBody = z.object({ values: z.unknown(), lockedKeys: z.array(z.string().max(200)).max(200).default([]) });
const GLOBAL_ID = "global";

@Controller("v1")
@UseGuards(AdminGuard)
export class ConfigController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
  ) {}

  /** Resolves the owning org/hotel of a scope through the caller's RLS context and checks the permission. */
  private async authorize(p: Principal, perm: Permission, scopeType: ScopeType, scopeId: string): Promise<{ orgId: string | null }> {
    if (scopeType === "GLOBAL") {
      if (scopeId !== GLOBAL_ID) throw new BadRequestException({ code: "GLOBAL_SCOPE_ID_MUST_BE_global" });
      if (perm === "config:write" && !p.isPlatformAdmin) throw new ForbiddenException({ code: "PLATFORM_ONLY" });
      return { orgId: null };
    }
    uuidParam(scopeId, "scopeId");
    if (scopeType === "ORG") {
      if (!this.access.can(p, perm, scopeId, null)) throw new ForbiddenException({ code: "FORBIDDEN", permission: perm });
      return { orgId: scopeId };
    }
    if (scopeType === "HOTEL") return { orgId: (await this.access.requireHotel(p, perm, scopeId)).orgId };
    if (scopeType === "ROOM") return { orgId: (await this.access.requireRoom(p, perm, scopeId)).orgId };
    if (scopeType === "DEVICE") return { orgId: (await this.access.requireDevice(p, perm, scopeId)).orgId };
    const g = await withTenant(this.db, this.access.ctxFor(p), async (tx) => {
      const [x] = await tx.select().from(schema.roomGroups).where(eq(schema.roomGroups.id, scopeId));
      return x;
    });
    if (!g) throw new NotFoundException({ code: "GROUP_NOT_FOUND" });
    if (!this.access.can(p, perm, g.organizationId, g.hotelId)) throw new ForbiddenException({ code: "FORBIDDEN", permission: perm });
    return { orgId: g.organizationId };
  }

  @Get("config/:scopeType/:scopeId")
  async get(@CurrentPrincipal() p: Principal, @Param("scopeType") st: string, @Param("scopeId") scopeId: string) {
    const scopeType = parse(ScopeType, st);
    await this.authorize(p, "config:read", scopeType, scopeId);
    return withTenant(this.db, this.access.ctxFor(p), async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.configLayers)
        .where(and(eq(schema.configLayers.scopeType, scopeType), eq(schema.configLayers.scopeId, scopeId)));
      return row ?? { scopeType, scopeId, values: {}, lockedKeys: [], version: 0 };
    });
  }

  @Put("config/:scopeType/:scopeId")
  async put(@CurrentPrincipal() p: Principal, @Param("scopeType") st: string, @Param("scopeId") scopeId: string, @Body() body: unknown) {
    const scopeType = parse(ScopeType, st);
    const { orgId } = await this.authorize(p, "config:write", scopeType, scopeId);
    const b = parse(PutBody, body);
    const values = parse(PolicyConfigSchema, b.values ?? {});
    const saved = await withTenant(this.db, this.access.ctxFor(p), async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.configLayers)
        .where(and(eq(schema.configLayers.scopeType, scopeType), eq(schema.configLayers.scopeId, scopeId)));
      let row;
      if (existing) {
        [row] = await tx
          .update(schema.configLayers)
          .set({ values, lockedKeys: b.lockedKeys, version: existing.version + 1, updatedBy: p.userId, updatedAt: new Date() })
          .where(eq(schema.configLayers.id, existing.id))
          .returning();
      } else {
        [row] = await tx
          .insert(schema.configLayers)
          .values({ organizationId: orgId, scopeType, scopeId, values, lockedKeys: b.lockedKeys, updatedBy: p.userId })
          .returning();
      }
      await tx.insert(schema.configLayerHistory).values({
        organizationId: orgId,
        layerId: row.id,
        version: row.version,
        values,
        lockedKeys: b.lockedKeys,
        updatedBy: p.userId,
      });
      await this.audit.log(tx, {
        organizationId: orgId,
        actorType: "USER",
        actorId: p.userId,
        action: "config.update",
        targetType: scopeType,
        targetId: scopeId,
        data: { before: existing?.values ?? null, after: values, lockedKeys: b.lockedKeys },
        ip: p.ip,
      });
      return row;
    });
    const refreshed = await this.policy.refreshScope({ scopeType, scopeId });
    return { layer: saved, devicesRecomputed: refreshed.devices };
  }

  @Get("devices/:id/effective-policy")
  async effective(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const d = await this.access.requireDevice(p, "config:read", uuidParam(id));
    const latest = await this.policy.latestDecoded(d.ctx, d.id);
    if (!latest) throw new NotFoundException({ code: "NO_POLICY_YET" });
    return latest;
  }
}
