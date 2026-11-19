import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { type Db, schema, withTenant } from "@hotel-os/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AccessService } from "../auth/access.service";
import { AdminGuard } from "../auth/admin.guard";
import { CurrentPrincipal, type Principal } from "../auth/principal";
import { AuditService } from "../common/audit.service";
import { DB } from "../common/db.module";
import { parse, uuidParam } from "../common/validation";
import type { DevicePrincipal } from "../devices/device-auth.service";
import { CurrentDevice, DeviceGuard } from "../devices/device.guard";
import { PolicyService } from "../policy/policy.service";
import { IptvService } from "./iptv.service";
import { SecretsService } from "./secrets.service";

const httpUrl = z.string().url().refine((u) => /^https?:\/\//.test(u), "http(s) URL required");
const CreateSource = z.object({
  name: z.string().min(1).max(100),
  playlistUrl: httpUrl,
  epgUrl: httpUrl.optional(),
  credentials: z.object({ username: z.string().max(200), password: z.string().max(200) }).optional(),
  /** Must be true: the hotel declares it holds the rights to broadcast these streams in rooms. */
  rightsAttestation: z.literal(true, { errorMap: () => ({ message: "broadcasting rights attestation is required" }) }),
});

@Controller()
export class IptvController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly iptv: IptvService,
    private readonly secrets: SecretsService,
    private readonly policy: PolicyService,
  ) {}

  @Post("v1/hotels/:id/iptv/sources")
  @UseGuards(AdminGuard)
  async create(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body() body: unknown) {
    const s = await this.access.requireHotel(p, "config:write", uuidParam(id));
    const b = parse(CreateSource, body);
    const src = await withTenant(this.db, s.ctx, async (tx) => {
      const [row] = await tx
        .insert(schema.iptvSources)
        .values({ organizationId: s.orgId, hotelId: s.hotelId, name: b.name, playlistUrl: b.playlistUrl, epgUrl: b.epgUrl, credentialsEnc: b.credentials ? this.secrets.encrypt(JSON.stringify(b.credentials)) : null, rightsAttestedBy: p.userId })
        .returning({ id: schema.iptvSources.id });
      await this.audit.log(tx, { organizationId: s.orgId, actorType: "USER", actorId: p.userId, action: "iptv.source_create", targetType: "IPTV_SOURCE", targetId: row.id, data: { name: b.name, rightsAttestation: true }, ip: p.ip });
      return row;
    });
    const sync = await this.iptv.sync(src.id);
    return { id: src.id, sync };
  }

  @Get("v1/hotels/:id/iptv/sources")
  @UseGuards(AdminGuard)
  async list(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const s = await this.access.requireHotel(p, "config:read", uuidParam(id));
    const rows = await withTenant(this.db, s.ctx, (tx) => tx.select().from(schema.iptvSources).where(eq(schema.iptvSources.hotelId, s.hotelId)));
    return rows.map(({ credentialsEnc, ...r }) => ({ ...r, hasCredentials: !!credentialsEnc }));
  }

  @Post("v1/iptv/sources/:id/sync")
  @UseGuards(AdminGuard)
  @HttpCode(200)
  async sync(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const sid = uuidParam(id);
    const [src] = await withTenant(this.db, this.access.ctxFor(p), (tx) => tx.select().from(schema.iptvSources).where(eq(schema.iptvSources.id, sid)));
    if (!src) throw new NotFoundException({ code: "SOURCE_NOT_FOUND" });
    await this.access.requireHotel(p, "config:write", src.hotelId);
    return this.iptv.sync(sid);
  }

  @Get("v1/hotels/:id/iptv/channels")
  @UseGuards(AdminGuard)
  async channels(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const s = await this.access.requireHotel(p, "config:read", uuidParam(id));
    return this.iptv.lineup(s.ctx, s.hotelId, false);
  }

  @Patch("v1/iptv/channels/:id")
  @UseGuards(AdminGuard)
  async updateChannel(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body() body: unknown) {
    const cid = uuidParam(id);
    const b = parse(z.object({ enabled: z.boolean().optional(), number: z.number().int().min(1).max(9999).optional(), category: z.string().max(60).optional() }), body);
    const [ch] = await withTenant(this.db, this.access.ctxFor(p), (tx) => tx.select().from(schema.channels).where(eq(schema.channels.id, cid)));
    if (!ch) throw new NotFoundException({ code: "CHANNEL_NOT_FOUND" });
    const s = await this.access.requireHotel(p, "config:write", ch.hotelId);
    return withTenant(this.db, s.ctx, async (tx) => {
      const [row] = await tx.update(schema.channels).set({ ...b, updatedAt: new Date() }).where(eq(schema.channels.id, cid)).returning();
      await this.audit.log(tx, { organizationId: s.orgId, actorType: "USER", actorId: p.userId, action: "iptv.channel_update", targetType: "CHANNEL", targetId: cid, data: b, ip: p.ip });
      return row;
    });
  }

  // ---------------------------------------------------------------- device side
  private async requireIptvEnabled(d: DevicePrincipal) {
    const latest = await this.policy.latestDecoded({ orgIds: [d.orgId] }, d.deviceId);
    if (!latest?.policy.iptv.enabled) throw new ForbiddenException({ code: "IPTV_NOT_ENABLED_FOR_DEVICE" });
  }

  @Get("device/v1/iptv/lineup")
  @UseGuards(DeviceGuard)
  async deviceLineup(@CurrentDevice() d: DevicePrincipal) {
    await this.requireIptvEnabled(d);
    const channels = await this.iptv.lineup({ orgIds: [d.orgId] }, d.hotelId, true);
    return { generatedAt: new Date().toISOString(), channels: channels.map(({ enabled: _e, ...c }) => c) };
  }

  @Get("device/v1/iptv/epg")
  @UseGuards(DeviceGuard)
  async deviceEpg(@CurrentDevice() d: DevicePrincipal, @Query("hours") hoursRaw?: string) {
    await this.requireIptvEnabled(d);
    const hours = hoursRaw ? Number(hoursRaw) : 24;
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new BadRequestException({ code: "INVALID_HOURS" });
    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + hours * 3600_000);
    return { from: from.toISOString(), to: to.toISOString(), programmes: await this.iptv.epg({ orgIds: [d.orgId] }, d.hotelId, from, to) };
  }
}
