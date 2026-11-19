import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { type Db, schema, type TenantContext, withTenant } from "@hotel-os/db";
import type { ApkArtifact, HardwareInfo, ObservedApp } from "@hotel-os/protocol";
type ReconcileError = { key: string; message: string };
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { AuditService } from "../common/audit.service";
import { DB } from "../common/db.module";
import { APP_CONFIG, type AppConfig } from "../config";
import { PolicyService } from "../policy/policy.service";
import { type ApkAnalysis, compatibleWith } from "./apk-analyzer";

const SYSTEM: TenantContext = { orgIds: [], platform: true };
export type RolloutScope = "ALL_HOTELS" | "ORG" | "HOTEL" | "GROUP" | "ROOM" | "DEVICE";

export interface CreateRollout {
  orgId: string | null;
  appVersionId: string;
  scopeType: RolloutScope;
  scopeId: string | null;
  rings: number[];
  failureThresholdPct: number;
  autoAdvance: boolean;
  updateWindow: "IMMEDIATE" | "MAINTENANCE";
}

type DeviceRow = { id: string; organizationId: string; hotelId: string; roomId: string | null; hardware: unknown };

/** Deterministic, uniformly spread position of a device inside a rollout (stable across recomputations). */
const rank = (rolloutId: string, deviceId: string) => createHash("sha256").update(`${rolloutId}:${deviceId}`).digest().readUInt32BE(0);

export function assignRings(rolloutId: string, deviceIds: string[], rings: number[]): Map<string, number> {
  const ordered = [...deviceIds].sort((a, b) => rank(rolloutId, a) - rank(rolloutId, b) || a.localeCompare(b));
  const n = ordered.length;
  const out = new Map<string, number>();
  ordered.forEach((d, i) => {
    const r = rings.findIndex((pct) => i < Math.max(1, Math.ceil((n * pct) / 100)));
    out.set(d, r < 0 ? rings.length - 1 : r);
  });
  return out;
}

/**
 * Progressive APK deployment: rings (e.g. 5 % → 25 % → 100 %), compatibility filter,
 * success measured from the inventory devices REPORT (never assumed), auto-pause on failures.
 */
@Injectable()
export class RolloutsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RolloutsService.name);
  private timer?: NodeJS.Timeout;
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.policy.setArtifactResolver((tx, device, groupIds) => this.artifactsForDevice(tx, device, groupIds));
    this.timer = setInterval(() => void this.evaluateAll().catch((e) => this.log.error(e)), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async scopeDevices(tx: Db, scopeType: RolloutScope, scopeId: string | null): Promise<DeviceRow[]> {
    const d = schema.devices;
    const cols = { id: d.id, organizationId: d.organizationId, hotelId: d.hotelId, roomId: d.roomId, hardware: d.hardware };
    const active = inArray(d.status, ["ENROLLED", "ACTIVE"]);
    switch (scopeType) {
      case "ALL_HOTELS":
        return tx.select(cols).from(d).where(active);
      case "ORG":
        return tx.select(cols).from(d).where(and(active, eq(d.organizationId, scopeId!)));
      case "HOTEL":
        return tx.select(cols).from(d).where(and(active, eq(d.hotelId, scopeId!)));
      case "ROOM":
        return tx.select(cols).from(d).where(and(active, eq(d.roomId, scopeId!)));
      case "DEVICE":
        return tx.select(cols).from(d).where(and(active, eq(d.id, scopeId!)));
      case "GROUP":
        return tx
          .select(cols)
          .from(d)
          .innerJoin(schema.roomGroupMembers, eq(schema.roomGroupMembers.roomId, d.roomId))
          .where(and(active, eq(schema.roomGroupMembers.groupId, scopeId!)));
    }
  }

  async create(ctx: TenantContext, input: CreateRollout, userId: string) {
    const rings = input.rings;
    if (!rings.length || rings.some((r, i) => r < 1 || r > 100 || (i > 0 && r <= rings[i - 1])) || rings[rings.length - 1] !== 100) {
      throw new BadRequestException({ code: "INVALID_RINGS", message: "rings must be increasing cumulative percentages ending at 100, e.g. [5, 25, 100]" });
    }
    const created = await withTenant(this.db, ctx, async (tx) => {
      const [v] = await tx.select({ v: schema.appVersions, app: schema.apps }).from(schema.appVersions).innerJoin(schema.apps, eq(schema.apps.id, schema.appVersions.appId)).where(eq(schema.appVersions.id, input.appVersionId));
      if (!v) throw new NotFoundException({ code: "APP_VERSION_NOT_FOUND" });
      if (!["VERIFIED", "PUBLISHED"].includes(v.v.status)) throw new ConflictException({ code: "VERSION_NOT_DEPLOYABLE", status: v.v.status });
      if (v.app.organizationId && v.app.organizationId !== input.orgId) throw new BadRequestException({ code: "APP_NOT_IN_SCOPE_ORG" });
      const overlapping = await tx
        .select({ id: schema.rollouts.id })
        .from(schema.rollouts)
        .where(and(eq(schema.rollouts.packageName, v.app.packageName), eq(schema.rollouts.scopeType, input.scopeType), input.scopeId ? eq(schema.rollouts.scopeId, input.scopeId) : isNull(schema.rollouts.scopeId), inArray(schema.rollouts.status, ["RUNNING", "PAUSED"])));
      if (overlapping.length) throw new ConflictException({ code: "ROLLOUT_IN_PROGRESS", rolloutId: overlapping[0].id, message: "finish, cancel or supersede the running rollout for this package and scope first" });

      const [rollout] = await tx
        .insert(schema.rollouts)
        .values({ organizationId: input.orgId, appVersionId: v.v.id, packageName: v.app.packageName, scopeType: input.scopeType, scopeId: input.scopeId, rings, failureThresholdPct: input.failureThresholdPct, autoAdvance: input.autoAdvance, updateWindow: input.updateWindow, createdBy: userId })
        .returning();
      // Device enumeration crosses tenants only for ALL_HOTELS (platform admin, SYSTEM context).
      const devices = await this.scopeDevices(tx, input.scopeType, input.scopeId);
      const a = v.v.analysis as ApkAnalysis;
      const inventory = devices.length
        ? await tx.select().from(schema.deviceAppInventory).where(and(inArray(schema.deviceAppInventory.deviceId, devices.map((d) => d.id)), eq(schema.deviceAppInventory.packageName, v.app.packageName)))
        : [];
      const eligible: string[] = [];
      const skipped: { device: DeviceRow; reason: string }[] = [];
      for (const d of devices) {
        const hw = d.hardware as Partial<HardwareInfo>;
        const installed = inventory.find((i) => i.deviceId === d.id);
        const reason =
          compatibleWith(a, { sdkInt: hw.sdkInt, supportedAbis: hw.supportedAbis }) ??
          (installed && installed.versionCode > v.v.versionCode ? `downgrade refused by Android (installed ${installed.versionCode} > ${v.v.versionCode}); roll forward instead` : null) ??
          (installed?.signerSha256 && installed.signerSha256 !== v.v.signerSha256 ? "installed app is signed with another key: Android will refuse the update" : null);
        if (reason) skipped.push({ device: d, reason });
        else eligible.push(d.id);
      }
      const ringOf = assignRings(rollout.id, eligible, rings);
      const rows = [
        ...devices.filter((d) => ringOf.has(d.id)).map((d) => ({ rolloutId: rollout.id, organizationId: d.organizationId, deviceId: d.id, ring: ringOf.get(d.id)!, state: ringOf.get(d.id) === 0 ? ("TARGETED" as const) : ("WAITING" as const) })),
        ...skipped.map(({ device, reason }) => ({ rolloutId: rollout.id, organizationId: device.organizationId, deviceId: device.id, ring: -1, state: "SKIPPED_INCOMPATIBLE" as const, message: reason })),
      ];
      if (rows.length) await tx.insert(schema.rolloutTargets).values(rows);
      await this.audit.log(tx, { organizationId: input.orgId, actorType: "USER", actorId: userId, action: input.scopeType === "ALL_HOTELS" ? "rollout.create_all_hotels" : "rollout.create", targetType: "ROLLOUT", targetId: rollout.id, data: { packageName: v.app.packageName, versionCode: v.v.versionCode, scope: `${input.scopeType}:${input.scopeId ?? "*"}`, rings, devices: devices.length, skipped: skipped.length } });
      return { rollout, targeted: rows.filter((r) => r.state === "TARGETED").map((r) => r.deviceId) };
    });
    for (const id of created.targeted) await this.policy.refreshDevice(id);
    await this.evaluate(created.rollout.id);
    return this.get(ctx, created.rollout.id);
  }

  async get(ctx: TenantContext, id: string) {
    return withTenant(this.db, ctx, async (tx) => {
      const [r] = await tx.select().from(schema.rollouts).where(eq(schema.rollouts.id, id));
      if (!r) throw new NotFoundException({ code: "ROLLOUT_NOT_FOUND" });
      const [v] = await tx.select({ versionCode: schema.appVersions.versionCode, versionName: schema.appVersions.versionName }).from(schema.appVersions).where(eq(schema.appVersions.id, r.appVersionId));
      const targets = await tx.select().from(schema.rolloutTargets).where(eq(schema.rolloutTargets.rolloutId, id)).orderBy(asc(schema.rolloutTargets.ring));
      const counts: Record<string, number> = { WAITING: 0, TARGETED: 0, SUCCEEDED: 0, FAILED: 0, SKIPPED_INCOMPATIBLE: 0 };
      for (const t of targets) counts[t.state]++;
      const perRing = r.rings.map((pct, i) => {
        const ts = targets.filter((t) => t.ring === i);
        return { ring: i, cumulativePct: pct, devices: ts.length, succeeded: ts.filter((t) => t.state === "SUCCEEDED").length, failed: ts.filter((t) => t.state === "FAILED").length, open: i <= r.currentRing };
      });
      return { ...r, version: v, counts, perRing, targets };
    });
  }

  async list(ctx: TenantContext, orgId: string | null) {
    return withTenant(this.db, ctx, (tx) =>
      tx
        .select()
        .from(schema.rollouts)
        .where(orgId ? or(eq(schema.rollouts.organizationId, orgId), isNull(schema.rollouts.organizationId)) : isNull(schema.rollouts.organizationId))
        .orderBy(asc(schema.rollouts.createdAt)),
    );
  }

  /** Opens the next ring. */
  async advance(ctx: TenantContext, id: string, actor: string) {
    const opened = await withTenant(this.db, ctx, async (tx) => {
      const [r] = await tx.select().from(schema.rollouts).where(eq(schema.rollouts.id, id)).for("update");
      if (!r) throw new NotFoundException({ code: "ROLLOUT_NOT_FOUND" });
      if (r.status !== "RUNNING") throw new ConflictException({ code: "ROLLOUT_NOT_RUNNING", status: r.status });
      if (r.currentRing >= r.rings.length - 1) throw new ConflictException({ code: "LAST_RING_ALREADY_OPEN" });
      const next = r.currentRing + 1;
      await tx.update(schema.rollouts).set({ currentRing: next, updatedAt: new Date() }).where(eq(schema.rollouts.id, id));
      const rows = await tx
        .update(schema.rolloutTargets).set({ state: "TARGETED", updatedAt: new Date() }).where(and(eq(schema.rolloutTargets.rolloutId, id), eq(schema.rolloutTargets.state, "WAITING"), eq(schema.rolloutTargets.ring, next))).returning({ deviceId: schema.rolloutTargets.deviceId });
      await this.audit.log(tx, { organizationId: r.organizationId, actorType: actor === "system" ? "SYSTEM" : "USER", actorId: actor, action: "rollout.advance", targetType: "ROLLOUT", targetId: id, data: { ring: next, devices: rows.length } });
      return rows.map((x) => x.deviceId);
    });
    for (const d of opened) await this.policy.refreshDevice(d);
    return this.get(ctx, id);
  }

  async setStatus(ctx: TenantContext, id: string, status: "PAUSED" | "RUNNING" | "CANCELLED", actor: string, reason?: string) {
    const affected = await withTenant(this.db, ctx, async (tx) => {
      const [r] = await tx.select().from(schema.rollouts).where(eq(schema.rollouts.id, id)).for("update");
      if (!r) throw new NotFoundException({ code: "ROLLOUT_NOT_FOUND" });
      const allowed: Record<string, string[]> = { PAUSED: ["RUNNING"], RUNNING: ["PAUSED"], CANCELLED: ["RUNNING", "PAUSED"] };
      if (!allowed[status].includes(r.status)) throw new ConflictException({ code: "INVALID_TRANSITION", from: r.status, to: status });
      await tx.update(schema.rollouts).set({ status, pausedReason: status === "RUNNING" ? null : (reason ?? null), updatedAt: new Date() }).where(eq(schema.rollouts.id, id));
      await this.audit.log(tx, { organizationId: r.organizationId, actorType: actor === "system" ? "SYSTEM" : "USER", actorId: actor, action: `rollout.${status.toLowerCase()}`, targetType: "ROLLOUT", targetId: id, data: { reason } });
      if (status !== "CANCELLED") return [];
      const ts = await tx.select({ deviceId: schema.rolloutTargets.deviceId }).from(schema.rolloutTargets).where(and(eq(schema.rolloutTargets.rolloutId, id), inArray(schema.rolloutTargets.state, ["TARGETED", "FAILED"])));
      return ts.map((t) => t.deviceId);
    });
    // Cancelled: devices not yet updated lose the target (already updated ones keep it: no downgrade).
    for (const d of affected) await this.policy.refreshDevice(d);
    return this.get(ctx, id);
  }

  /** Called on every device state report: success/failure is what the device observed, nothing else. */
  async onDeviceState(deviceId: string, apps: ObservedApp[], errors: ReconcileError[], inventoryIsDelta: boolean) {
    const touched = await withTenant(this.db, SYSTEM, async (tx) => {
      const ts = await tx
        .select({ t: schema.rolloutTargets, r: schema.rollouts, v: schema.appVersions })
        .from(schema.rolloutTargets)
        .innerJoin(schema.rollouts, eq(schema.rollouts.id, schema.rolloutTargets.rolloutId))
        .innerJoin(schema.appVersions, eq(schema.appVersions.id, schema.rollouts.appVersionId))
        .where(and(eq(schema.rolloutTargets.deviceId, deviceId), inArray(schema.rolloutTargets.state, ["TARGETED", "FAILED"]), inArray(schema.rollouts.status, ["RUNNING", "PAUSED"])));
      const ids = new Set<string>();
      for (const { t, r, v } of ts) {
        const inv = apps.find((a) => a.packageName === r.packageName);
        const err = errors.find((e) => e.key === `apps.${r.packageName}.install`);
        let state: "SUCCEEDED" | "FAILED" | null = null;
        let message: string | null = null;
        if (inv && inv.versionCode >= v.versionCode) state = "SUCCEEDED";
        else if (err) [state, message] = ["FAILED", err.message];
        else if (!inv && !inventoryIsDelta && t.state === "FAILED") continue;
        if (!state || state === t.state) continue;
        await tx.update(schema.rolloutTargets).set({ state, message, updatedAt: new Date() }).where(and(eq(schema.rolloutTargets.rolloutId, t.rolloutId), eq(schema.rolloutTargets.deviceId, deviceId)));
        ids.add(t.rolloutId);
      }
      return [...ids];
    });
    for (const id of touched) await this.evaluate(id);
  }

  /** Health check: auto-pause on failure rate, auto-advance if enabled, completion. */
  async evaluate(id: string) {
    const r = await this.get(SYSTEM, id);
    if (r.status !== "RUNNING") return;
    const opened = r.targets.filter((t) => t.ring >= 0 && t.ring <= r.currentRing);
    const failed = opened.filter((t) => t.state === "FAILED").length;
    const done = opened.filter((t) => t.state === "SUCCEEDED" || t.state === "FAILED").length;
    if (failed > 0 && (failed * 100) / Math.max(1, done) > r.failureThresholdPct) {
      await this.setStatus(SYSTEM, id, "PAUSED", "system", `auto-paused: ${failed}/${done} installations failed (threshold ${r.failureThresholdPct} %)`);
      return;
    }
    const ringComplete = opened.every((t) => t.state === "SUCCEEDED" || t.state === "FAILED");
    if (!ringComplete) return;
    if (r.currentRing >= r.rings.length - 1) {
      await withTenant(this.db, SYSTEM, async (tx) => {
        await tx.update(schema.rollouts).set({ status: "COMPLETED", updatedAt: new Date() }).where(eq(schema.rollouts.id, id));
        await tx.update(schema.appVersions).set({ status: "PUBLISHED" }).where(eq(schema.appVersions.id, r.appVersionId));
        await this.audit.log(tx, { organizationId: r.organizationId, actorType: "SYSTEM", actorId: "system", action: "rollout.completed", targetType: "ROLLOUT", targetId: id });
      });
    } else if (r.autoAdvance) {
      await this.advance(SYSTEM, id, "system");
      await this.evaluate(id);
    }
  }

  private async evaluateAll() {
    const running = await withTenant(this.db, SYSTEM, (tx) => tx.select({ id: schema.rollouts.id }).from(schema.rollouts).where(eq(schema.rollouts.status, "RUNNING")));
    for (const r of running) await this.evaluate(r.id);
  }

  /**
   * APKs that THIS device must have:
   *  - targets of running/paused rollouts in an opened ring (TARGETED / SUCCEEDED / FAILED → keep retrying),
   *  - SUCCEEDED targets of cancelled rollouts (already installed, cannot be downgraded),
   *  - completed rollouts whose scope includes the device (covers boxes added after completion).
   * Highest versionCode wins per package (rollback = roll-forward).
   */
  async artifactsForDevice(tx: Db, device: { id: string; organizationId: string; hotelId: string; roomId: string | null; hardware: unknown }, groupIds: string[]): Promise<Record<string, ApkArtifact>> {
    const best = new Map<string, { code: number; art: ApkArtifact }>();
    const take = (pkg: string, v: typeof schema.appVersions.$inferSelect, window: string) => {
      const cur = best.get(pkg);
      if (cur && cur.code >= v.versionCode) return;
      best.set(pkg, {
        code: v.versionCode,
        art: { versionCode: v.versionCode, versionName: v.versionName, url: new URL(v.sha256, this.cfg.PUBLIC_DOWNLOAD_BASE).toString(), sha256: v.sha256, signerSha256: v.signerSha256, sizeBytes: v.sizeBytes, updateWindow: window === "IMMEDIATE" ? "IMMEDIATE" : "MAINTENANCE" },
      });
    };
    const fromTargets = await tx
      .select({ t: schema.rolloutTargets, r: schema.rollouts, v: schema.appVersions })
      .from(schema.rolloutTargets)
      .innerJoin(schema.rollouts, eq(schema.rollouts.id, schema.rolloutTargets.rolloutId))
      .innerJoin(schema.appVersions, eq(schema.appVersions.id, schema.rollouts.appVersionId))
      .where(and(eq(schema.rolloutTargets.deviceId, device.id), inArray(schema.rolloutTargets.state, ["TARGETED", "SUCCEEDED", "FAILED"])));
    for (const { t, r, v } of fromTargets) {
      if (r.status === "CANCELLED" && t.state !== "SUCCEEDED") continue;
      take(r.packageName, v, r.updateWindow);
    }
    const completed = await tx
      .select({ r: schema.rollouts, v: schema.appVersions })
      .from(schema.rollouts)
      .innerJoin(schema.appVersions, eq(schema.appVersions.id, schema.rollouts.appVersionId))
      .where(and(eq(schema.rollouts.status, "COMPLETED"), or(isNull(schema.rollouts.organizationId), eq(schema.rollouts.organizationId, device.organizationId))));
    const hw = device.hardware as Partial<HardwareInfo>;
    for (const { r, v } of completed) {
      const inScope =
        r.scopeType === "ALL_HOTELS" ||
        (r.scopeType === "ORG" && r.scopeId === device.organizationId) ||
        (r.scopeType === "HOTEL" && r.scopeId === device.hotelId) ||
        (r.scopeType === "ROOM" && r.scopeId === device.roomId) ||
        (r.scopeType === "DEVICE" && r.scopeId === device.id) ||
        (r.scopeType === "GROUP" && groupIds.includes(r.scopeId ?? ""));
      if (!inScope) continue;
      if (compatibleWith(v.analysis as ApkAnalysis, { sdkInt: hw.sdkInt, supportedAbis: hw.supportedAbis })) continue;
      take(r.packageName, v, r.updateWindow);
    }
    return Object.fromEntries([...best].map(([k, x]) => [k, x.art]));
  }
}
