import { Body, Controller, Get, Inject, NotFoundException, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { type Db, schema, withTenant } from "@hotel-os/db";
import { Language } from "@hotel-os/protocol";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { AccessService } from "../auth/access.service";
import { AdminGuard } from "../auth/admin.guard";
import { CurrentPrincipal, type Principal } from "../auth/principal";
import { AuditService } from "../common/audit.service";
import { DB } from "../common/db.module";
import { parse, uuidParam } from "../common/validation";
import { PolicyService } from "../policy/policy.service";

const tz = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, "invalid IANA timezone");

const HotelBody = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).optional(),
  timezone: tz.default("Europe/Paris"),
  defaultLanguage: Language.default("fr"),
  languages: z.array(Language).min(1).default(["fr", "en"]),
  contact: z.record(z.string()).default({}),
});

@Controller("v1")
@UseGuards(AdminGuard)
export class HotelsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
  ) {}

  @Post("organizations/:orgId/hotels")
  async create(@CurrentPrincipal() p: Principal, @Param("orgId") orgIdRaw: string, @Body() body: unknown) {
    const orgId = uuidParam(orgIdRaw);
    if (!this.access.can(p, "hotel:write", orgId, null)) throw new NotFoundException({ code: "ORG_NOT_FOUND" });
    const b = parse(HotelBody, body);
    return withTenant(this.db, this.access.ctxFor(p), async (tx) => {
      const [h] = await tx.insert(schema.hotels).values({ ...b, organizationId: orgId }).returning();
      await this.audit.log(tx, { organizationId: orgId, actorType: "USER", actorId: p.userId, action: "hotel.create", targetType: "HOTEL", targetId: h.id, data: b, ip: p.ip });
      return h;
    });
  }

  /** All hotels the caller can read (RLS + hotel-scoped memberships). */
  @Get("hotels")
  list(@CurrentPrincipal() p: Principal) {
    return withTenant(this.db, this.access.ctxFor(p), async (tx) => {
      const rows = await tx.select().from(schema.hotels).orderBy(asc(schema.hotels.name));
      return rows.filter((h) => this.access.can(p, "hotel:read", h.organizationId, h.id));
    });
  }

  @Get("hotels/:id")
  async get(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const s = await this.access.requireHotel(p, "hotel:read", uuidParam(id));
    return withTenant(this.db, s.ctx, async (tx) => (await tx.select().from(schema.hotels).where(eq(schema.hotels.id, s.hotelId)))[0]);
  }

  @Patch("hotels/:id")
  async update(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body() body: unknown) {
    const s = await this.access.requireHotel(p, "hotel:write", uuidParam(id));
    const b = parse(HotelBody.partial(), body);
    const h = await withTenant(this.db, s.ctx, async (tx) => {
      const [h] = await tx.update(schema.hotels).set({ ...b, updatedAt: new Date() }).where(eq(schema.hotels.id, s.hotelId)).returning();
      await this.audit.log(tx, { organizationId: s.orgId, actorType: "USER", actorId: p.userId, action: "hotel.update", targetType: "HOTEL", targetId: s.hotelId, data: b, ip: p.ip });
      return h;
    });
    await this.policy.refreshScope({ scopeType: "HOTEL", scopeId: s.hotelId });
    return h;
  }

  // ------------------------------------------------------------ groups
  @Post("hotels/:id/groups")
  async createGroup(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body() body: unknown) {
    const s = await this.access.requireHotel(p, "room:write", uuidParam(id));
    const b = parse(z.object({ name: z.string().min(1).max(100), priority: z.number().int().min(-1000).max(1000).default(0) }), body);
    return withTenant(this.db, s.ctx, async (tx) => {
      const [g] = await tx.insert(schema.roomGroups).values({ ...b, organizationId: s.orgId, hotelId: s.hotelId }).returning();
      await this.audit.log(tx, { organizationId: s.orgId, actorType: "USER", actorId: p.userId, action: "group.create", targetType: "GROUP", targetId: g.id, data: b, ip: p.ip });
      return g;
    });
  }

  @Get("hotels/:id/groups")
  async groups(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const s = await this.access.requireHotel(p, "room:read", uuidParam(id));
    return withTenant(this.db, s.ctx, (tx) => tx.select().from(schema.roomGroups).where(eq(schema.roomGroups.hotelId, s.hotelId)).orderBy(asc(schema.roomGroups.name)));
  }

  // ------------------------------------------------------------ rooms
  @Post("hotels/:id/rooms")
  async createRoom(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body() body: unknown) {
    const s = await this.access.requireHotel(p, "room:write", uuidParam(id));
    const b = parse(z.object({ number: z.string().min(1).max(20), floor: z.string().max(20).optional(), roomType: z.string().max(50).optional(), groupIds: z.array(z.string().uuid()).default([]) }), body);
    return withTenant(this.db, s.ctx, async (tx) => {
      const [r] = await tx.insert(schema.rooms).values({ organizationId: s.orgId, hotelId: s.hotelId, number: b.number, floor: b.floor, roomType: b.roomType }).returning();
      await this.setGroups(tx, s, r.id, b.groupIds);
      await this.audit.log(tx, { organizationId: s.orgId, actorType: "USER", actorId: p.userId, action: "room.create", targetType: "ROOM", targetId: r.id, data: b, ip: p.ip });
      return r;
    });
  }

  /**
   * CSV import. Header required: number,floor,type,groups  (groups separated by "|", created if missing).
   * Existing room numbers are updated (idempotent).
   */
  @Post("hotels/:id/rooms/import")
  async importRooms(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body() body: unknown) {
    const s = await this.access.requireHotel(p, "room:write", uuidParam(id));
    const { csv } = parse(z.object({ csv: z.string().max(2_000_000) }), body);
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const header = lines.shift()?.split(",").map((h) => h.trim().toLowerCase());
    if (!header || header[0] !== "number") throw new NotFoundException({ code: "CSV_HEADER_REQUIRED", expected: "number,floor,type,groups" });
    const col = (name: string) => header.indexOf(name);
    const errors: { line: number; message: string }[] = [];
    let created = 0;
    let updated = 0;
    await withTenant(this.db, s.ctx, async (tx) => {
      const groupIdByName = new Map((await tx.select().from(schema.roomGroups).where(eq(schema.roomGroups.hotelId, s.hotelId))).map((g) => [g.name, g.id]));
      for (const [i, line] of lines.entries()) {
        const cells = line.split(",").map((c) => c.trim());
        const number = cells[col("number")];
        if (!number || number.length > 20) {
          errors.push({ line: i + 2, message: "invalid room number" });
          continue;
        }
        const floor = col("floor") >= 0 ? cells[col("floor")] || undefined : undefined;
        const roomType = col("type") >= 0 ? cells[col("type")] || undefined : undefined;
        const groupNames = col("groups") >= 0 && cells[col("groups")] ? cells[col("groups")].split("|").map((g) => g.trim()).filter(Boolean) : [];
        const groupIds: string[] = [];
        for (const name of groupNames) {
          if (!groupIdByName.has(name)) {
            const [g] = await tx.insert(schema.roomGroups).values({ organizationId: s.orgId, hotelId: s.hotelId, name }).returning();
            groupIdByName.set(name, g.id);
          }
          groupIds.push(groupIdByName.get(name)!);
        }
        const [existing] = await tx.select().from(schema.rooms).where(and(eq(schema.rooms.hotelId, s.hotelId), eq(schema.rooms.number, number)));
        let roomId: string;
        if (existing) {
          await tx.update(schema.rooms).set({ floor, roomType, updatedAt: new Date() }).where(eq(schema.rooms.id, existing.id));
          roomId = existing.id;
          updated++;
        } else {
          const [r] = await tx.insert(schema.rooms).values({ organizationId: s.orgId, hotelId: s.hotelId, number, floor, roomType }).returning();
          roomId = r.id;
          created++;
        }
        await this.setGroups(tx, s, roomId, groupIds);
      }
      await this.audit.log(tx, { organizationId: s.orgId, actorType: "USER", actorId: p.userId, action: "room.import", targetType: "HOTEL", targetId: s.hotelId, data: { created, updated, errors: errors.length }, ip: p.ip });
    });
    await this.policy.refreshScope({ scopeType: "HOTEL", scopeId: s.hotelId });
    return { created, updated, errors };
  }

  @Get("hotels/:id/rooms")
  async rooms(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const s = await this.access.requireHotel(p, "room:read", uuidParam(id));
    return withTenant(this.db, s.ctx, async (tx) => {
      const rooms = await tx.select().from(schema.rooms).where(eq(schema.rooms.hotelId, s.hotelId)).orderBy(asc(schema.rooms.number));
      const members = rooms.length
        ? await tx.select().from(schema.roomGroupMembers).where(inArray(schema.roomGroupMembers.roomId, rooms.map((r) => r.id)))
        : [];
      const devices = rooms.length
        ? await tx
            .select({ id: schema.devices.id, roomId: schema.devices.roomId, lastSeenAt: schema.devices.lastSeenAt, status: schema.devices.status })
            .from(schema.devices)
            .where(and(eq(schema.devices.hotelId, s.hotelId), inArray(schema.devices.status, ["ENROLLED", "ACTIVE"])))
        : [];
      return rooms.map((r) => ({
        ...r,
        groupIds: members.filter((m) => m.roomId === r.id).map((m) => m.groupId),
        device: devices.find((d) => d.roomId === r.id) ?? null,
      }));
    });
  }

  @Patch("rooms/:id")
  async updateRoom(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body() body: unknown) {
    const r = await this.access.requireRoom(p, "room:write", uuidParam(id));
    const b = parse(z.object({ floor: z.string().max(20).optional(), roomType: z.string().max(50).optional(), status: z.enum(["ACTIVE", "OUT_OF_ORDER"]).optional(), groupIds: z.array(z.string().uuid()).optional() }), body);
    await withTenant(this.db, r.ctx, async (tx) => {
      const { groupIds, ...fields } = b;
      if (Object.keys(fields).length) await tx.update(schema.rooms).set({ ...fields, updatedAt: new Date() }).where(eq(schema.rooms.id, r.id));
      if (groupIds) await this.setGroups(tx, { orgId: r.orgId, hotelId: r.hotelId }, r.id, groupIds);
      await this.audit.log(tx, { organizationId: r.orgId, actorType: "USER", actorId: p.userId, action: "room.update", targetType: "ROOM", targetId: r.id, data: b, ip: p.ip });
    });
    await this.policy.refreshScope({ scopeType: "ROOM", scopeId: r.id });
    return { ok: true };
  }

  private async setGroups(tx: Db, s: { orgId: string; hotelId: string }, roomId: string, groupIds: string[]) {
    if (groupIds.length) {
      const valid = await tx.select({ id: schema.roomGroups.id }).from(schema.roomGroups).where(and(eq(schema.roomGroups.hotelId, s.hotelId), inArray(schema.roomGroups.id, groupIds)));
      if (valid.length !== new Set(groupIds).size) throw new NotFoundException({ code: "GROUP_NOT_IN_HOTEL" });
    }
    await tx.delete(schema.roomGroupMembers).where(eq(schema.roomGroupMembers.roomId, roomId));
    if (groupIds.length) await tx.insert(schema.roomGroupMembers).values([...new Set(groupIds)].map((groupId) => ({ organizationId: s.orgId, roomId, groupId })));
  }
}
