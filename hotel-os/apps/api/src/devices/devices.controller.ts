import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { type Db, schema, withTenant } from "@hotel-os/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { AccessService } from "../auth/access.service";
import { AdminGuard } from "../auth/admin.guard";
import { CurrentPrincipal, type Principal } from "../auth/principal";
import { DB } from "../common/db.module";
import { parse, uuidParam } from "../common/validation";
import { DeviceConnections } from "../gateway/device-connections";
import { PolicyService } from "../policy/policy.service";
import { diffApps } from "./app-diff";
import { DevicesService } from "./devices.service";

@Controller("v1")
@UseGuards(AdminGuard)
export class DevicesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly devices: DevicesService,
    private readonly policy: PolicyService,
    private readonly conns: DeviceConnections,
  ) {}

  @Post("hotels/:id/enrollment-tokens")
  async token(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body() body: unknown) {
    const s = await this.access.requireHotel(p, "enroll:create", uuidParam(id));
    const b = parse(z.object({ maxUses: z.number().int().min(1).max(1000).default(1), ttlHours: z.number().int().min(1).max(168).default(24) }), body ?? {});
    return this.devices.createEnrollmentToken(s.ctx, s.orgId, s.hotelId, b.maxUses, b.ttlHours, p.userId);
  }

  @Get("hotels/:id/devices")
  async list(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const s = await this.access.requireHotel(p, "device:read", uuidParam(id));
    const rows = await withTenant(this.db, s.ctx, (tx) =>
      tx
        .select({ device: schema.devices, roomNumber: schema.rooms.number, model: schema.deviceModels })
        .from(schema.devices)
        .leftJoin(schema.rooms, eq(schema.rooms.id, schema.devices.roomId))
        .leftJoin(schema.deviceModels, eq(schema.deviceModels.id, schema.devices.deviceModelId))
        .where(and(eq(schema.devices.hotelId, s.hotelId), inArray(schema.devices.status, ["ENROLLED", "ACTIVE"])))
        .orderBy(schema.rooms.number),
    );
    return rows.map(({ device, roomNumber, model }) => ({
      id: device.id,
      status: device.status,
      roomId: device.roomId,
      roomNumber,
      model: model ? { manufacturer: model.manufacturer, model: model.model, certification: model.status } : null,
      online: this.conns.isOnline(device.id),
      lastSeenAt: device.lastSeenAt,
      isDeviceOwner: device.isDeviceOwner,
      kioskActive: device.kioskActive,
      launcherHealthy: device.launcherHealthy,
      policyVersionApplied: device.policyVersionApplied,
      versions: device.versions,
      reconcileErrors: device.reconcileErrors,
    }));
  }

  @Get("devices/:id")
  async get(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const d = await this.access.requireDevice(p, "device:read", uuidParam(id));
    const data = await withTenant(this.db, d.ctx, async (tx) => {
      const [device] = await tx.select().from(schema.devices).where(eq(schema.devices.id, d.id));
      const inventory = await tx.select().from(schema.deviceAppInventory).where(eq(schema.deviceAppInventory.deviceId, d.id));
      const history = await tx.select().from(schema.deviceRoomHistory).where(eq(schema.deviceRoomHistory.deviceId, d.id)).orderBy(desc(schema.deviceRoomHistory.createdAt)).limit(50);
      return { device, inventory, history };
    });
    const latest = await this.policy.latestDecoded(d.ctx, d.id);
    return {
      ...data,
      online: this.conns.isOnline(d.id),
      policy: latest ? { version: latest.version, warnings: latest.warnings, inSync: data.device.policyVersionApplied === latest.version } : null,
      apps: latest ? diffApps(latest.policy, data.inventory) : [],
    };
  }

  @Post("devices/pair")
  @HttpCode(200)
  async pair(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    const b = parse(z.object({ pairingCode: z.string().min(6).max(6), roomId: z.string().uuid() }), body);
    return this.devices.pair(this.access.ctxFor(p), (orgId, hotelId) => this.access.can(p, "device:pair", orgId, hotelId), b.pairingCode, b.roomId, p.userId);
  }

  @Post("devices/:id/revoke")
  @HttpCode(200)
  async revoke(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const d = await this.access.requireDevice(p, "device:revoke", uuidParam(id));
    await this.devices.revoke(d.ctx, d.orgId, d.id, p.userId);
    return { ok: true };
  }

  /** Hotel-level "Application | Installed | Allowed | Visible | Suspended | Hidden" table, from observed reality. */
  @Get("hotels/:id/apps")
  async apps(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const s = await this.access.requireHotel(p, "app:read", uuidParam(id));
    const devs = await withTenant(this.db, s.ctx, (tx) =>
      tx.select({ id: schema.devices.id }).from(schema.devices).where(and(eq(schema.devices.hotelId, s.hotelId), inArray(schema.devices.status, ["ENROLLED", "ACTIVE"]))),
    );
    if (!devs.length) return { devices: 0, apps: [] };
    const inventory = await withTenant(this.db, s.ctx, (tx) => tx.select().from(schema.deviceAppInventory).where(inArray(schema.deviceAppInventory.deviceId, devs.map((x) => x.id))));
    const agg = new Map<string, { packageName: string; label?: string | null; installed: number; allowed: number; visible: number; suspended: number; hidden: number; mismatched: number; notEnforceable: number; system: boolean }>();
    for (const dev of devs) {
      const latest = await this.policy.latestDecoded(s.ctx, dev.id);
      if (!latest) continue;
      for (const row of diffApps(latest.policy, inventory.filter((i) => i.deviceId === dev.id))) {
        const a = agg.get(row.packageName) ?? { packageName: row.packageName, label: row.label, installed: 0, allowed: 0, visible: 0, suspended: 0, hidden: 0, mismatched: 0, notEnforceable: 0, system: row.system };
        if (row.installed) a.installed++;
        if (row.desired === "ALLOWED") a.allowed++;
        if (row.visibleInLauncher) a.visible++;
        if (row.observedSuspended) a.suspended++;
        if (row.observedHidden) a.hidden++;
        if (!row.inSync) a.mismatched++;
        if (row.notEnforceable) a.notEnforceable++;
        a.label ??= row.label;
        agg.set(row.packageName, a);
      }
    }
    return { devices: devs.length, apps: [...agg.values()].sort((a, b) => (a.label ?? a.packageName).localeCompare(b.label ?? b.packageName)) };
  }

  @Get("device-models")
  async models() {
    return withTenant(this.db, { orgIds: [], platform: true }, (tx) => tx.select().from(schema.deviceModels).orderBy(schema.deviceModels.manufacturer, schema.deviceModels.model));
  }

  @Get("devices/:id/history")
  async history(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const d = await this.access.requireDevice(p, "device:read", uuidParam(id));
    const rows = await withTenant(this.db, d.ctx, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.targetId, d.id)).orderBy(desc(schema.auditLogs.createdAt)).limit(200));
    if (!rows) throw new NotFoundException();
    return rows;
  }
}
