import { Inject, Injectable, Logger } from "@nestjs/common";
import { type Db, schema, type TenantContext, withTenant } from "@hotel-os/db";
import {
  type ConfigLayer,
  type ModelCapabilities,
  type PolicyConfig,
  resolveEffectivePolicy,
  type ResolveOutput,
} from "@hotel-os/policy-engine";
import { type ApkArtifact, EffectivePolicy, type Language, SUPPORTED_LANGUAGES, type SignedPolicy } from "@hotel-os/protocol";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { DB } from "../common/db.module";
import { APP_CONFIG, type AppConfig } from "../config";
import { DeviceConnections } from "../gateway/device-connections";
import { SigningService } from "./signing.service";

const SYSTEM: TenantContext = { orgIds: [], platform: true };
const UNKNOWN_MODEL_CAPS: ModelCapabilities = { lockTaskSupported: false, persistentHomeSupported: false };

export type ScopeRef = { scopeType: ConfigLayer["scopeType"]; scopeId: string };

@Injectable()
export class PolicyService {
  private readonly log = new Logger(PolicyService.name);
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly signing: SigningService,
    private readonly conns: DeviceConnections,
  ) {}

  /** Builds all inputs for one device and runs the pure policy engine. */
  async computeForDevice(tx: Db, deviceId: string, version = 1): Promise<ResolveOutput> {
    const [device] = await tx.select().from(schema.devices).where(eq(schema.devices.id, deviceId));
    if (!device) throw new Error(`device ${deviceId} not found`);
    const [hotel] = await tx.select().from(schema.hotels).where(eq(schema.hotels.id, device.hotelId));
    const room = device.roomId ? (await tx.select().from(schema.rooms).where(eq(schema.rooms.id, device.roomId)))[0] : undefined;
    const groups = room
      ? await tx
          .select({ id: schema.roomGroups.id, priority: schema.roomGroups.priority })
          .from(schema.roomGroupMembers)
          .innerJoin(schema.roomGroups, eq(schema.roomGroups.id, schema.roomGroupMembers.groupId))
          .where(eq(schema.roomGroupMembers.roomId, room.id))
      : [];
    const groupPriority = new Map(groups.map((g) => [g.id, g.priority]));

    const scopeFilters = [
      and(eq(schema.configLayers.scopeType, "GLOBAL")),
      and(eq(schema.configLayers.scopeType, "ORG"), eq(schema.configLayers.scopeId, device.organizationId)),
      and(eq(schema.configLayers.scopeType, "HOTEL"), eq(schema.configLayers.scopeId, device.hotelId)),
      and(eq(schema.configLayers.scopeType, "DEVICE"), eq(schema.configLayers.scopeId, device.id)),
    ];
    if (room) scopeFilters.push(and(eq(schema.configLayers.scopeType, "ROOM"), eq(schema.configLayers.scopeId, room.id)));
    if (groups.length) scopeFilters.push(and(eq(schema.configLayers.scopeType, "GROUP"), inArray(schema.configLayers.scopeId, groups.map((g) => g.id))));
    const rows = await tx.select().from(schema.configLayers).where(or(...scopeFilters));

    const layers: ConfigLayer[] = rows.map((r) => ({
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      priority: r.scopeType === "GROUP" ? groupPriority.get(r.scopeId) ?? 0 : 0,
      values: r.values as PolicyConfig,
      lockedKeys: r.lockedKeys,
    }));

    // Synthetic layers derived from master data (lowest priority inside their scope).
    const langs = hotel.languages.filter((l): l is Language => (SUPPORTED_LANGUAGES as readonly string[]).includes(l));
    layers.push({
      scopeType: "HOTEL",
      scopeId: `hotel-profile:${hotel.id}`,
      priority: -1,
      values: {
        launcher: { branding: { hotelName: hotel.name }, language: hotel.defaultLanguage as Language, availableLanguages: langs.length ? langs : undefined },
        system: { timezone: hotel.timezone },
      },
    });
    if (room) {
      layers.push({ scopeType: "ROOM", scopeId: `room-profile:${room.id}`, priority: -1, values: { launcher: { roomNumber: room.number } } });
      const [stay] = await tx
        .select()
        .from(schema.stays)
        .where(and(eq(schema.stays.roomId, room.id), eq(schema.stays.status, "ACTIVE")));
      if (stay) {
        layers.push({
          scopeType: "ROOM",
          scopeId: `stay:${stay.id}`,
          priority: 1000,
          values: {
            launcher: {
              ...(stay.language && langs.includes(stay.language as Language) ? { language: stay.language as Language } : {}),
              ...(stay.displayNameConsent && stay.guestFirstName ? { guestFirstName: stay.guestFirstName } : {}),
            },
          },
        });
      }
    }

    const subs = await tx
      .select({ modules: schema.subscriptions.modules })
      .from(schema.subscriptions)
      .where(and(eq(schema.subscriptions.organizationId, device.organizationId), eq(schema.subscriptions.status, "ACTIVE")));
    const modules = [...new Set(subs.flatMap((s) => s.modules))];

    let capabilities = UNKNOWN_MODEL_CAPS;
    if (device.deviceModelId) {
      const [m] = await tx.select().from(schema.deviceModels).where(eq(schema.deviceModels.id, device.deviceModelId));
      if (m) capabilities = { ...UNKNOWN_MODEL_CAPS, ...(m.capabilities as Partial<ModelCapabilities>) };
    }

    const artifacts = await this.publishedArtifacts(tx, device.organizationId);
    return resolveEffectivePolicy({
      deviceId,
      version,
      issuedAt: new Date(),
      layers,
      entitlements: { modules },
      capabilities,
      artifacts,
    });
  }

  /** Latest PUBLISHED version per package visible to the org (org catalog overrides platform catalog). */
  private async publishedArtifacts(tx: Db, orgId: string): Promise<Record<string, ApkArtifact>> {
    const rows = await tx
      .select({ app: schema.apps, v: schema.appVersions })
      .from(schema.appVersions)
      .innerJoin(schema.apps, eq(schema.apps.id, schema.appVersions.appId))
      .where(and(eq(schema.appVersions.status, "PUBLISHED"), or(isNull(schema.apps.organizationId), eq(schema.apps.organizationId, orgId))))
      .orderBy(desc(schema.appVersions.versionCode));
    const out: Record<string, ApkArtifact & { org: boolean }> = {};
    for (const { app, v } of rows) {
      const isOrg = app.organizationId !== null;
      const cur = out[app.packageName];
      if (cur && (cur.org || !isOrg)) continue;
      out[app.packageName] = {
        versionCode: v.versionCode,
        versionName: v.versionName,
        url: new URL(v.objectKey, this.cfg.PUBLIC_DOWNLOAD_BASE).toString(),
        sha256: v.sha256,
        signerSha256: v.signerSha256,
        sizeBytes: v.sizeBytes,
        org: isOrg,
      };
    }
    return Object.fromEntries(Object.entries(out).map(([k, { org: _o, ...a }]) => [k, a]));
  }

  /**
   * Recomputes and stores the policy of a device. A new version is created only when content changed.
   * Returns the latest version number.
   */
  async refreshDevice(deviceId: string): Promise<number> {
    const result = await withTenant(this.db, SYSTEM, async (tx) => {
      const [latest] = await tx
        .select()
        .from(schema.effectivePolicies)
        .where(eq(schema.effectivePolicies.deviceId, deviceId))
        .orderBy(desc(schema.effectivePolicies.version))
        .limit(1);
      const out = await this.computeForDevice(tx, deviceId);
      const { version: _v, issuedAt: _i, ...content } = out.policy;
      const hash = createHash("sha256").update(JSON.stringify(content)).digest("hex");
      if (latest && latest.hash === hash) return { version: latest.version, changed: false };
      const version = (latest?.version ?? 0) + 1;
      const policy = EffectivePolicy.parse({ ...out.policy, version });
      const [device] = await tx.select({ orgId: schema.devices.organizationId }).from(schema.devices).where(eq(schema.devices.id, deviceId));
      await tx.insert(schema.effectivePolicies).values({
        organizationId: device.orgId,
        deviceId,
        version,
        hash,
        signed: this.signing.sign(JSON.stringify(policy), version),
        explain: out.explain,
        warnings: policy.warnings,
      });
      return { version, changed: true };
    });
    if (result.changed) this.conns.send(deviceId, { t: "policy.changed", version: result.version });
    return result.version;
  }

  /** Devices affected by a change at the given scope. */
  async devicesForScope(ref: ScopeRef): Promise<string[]> {
    return withTenant(this.db, SYSTEM, async (tx) => {
      const d = schema.devices;
      const active = inArray(d.status, ["ENROLLED", "ACTIVE"]);
      let rows: { id: string }[];
      switch (ref.scopeType) {
        case "GLOBAL":
          rows = await tx.select({ id: d.id }).from(d).where(active);
          break;
        case "ORG":
          rows = await tx.select({ id: d.id }).from(d).where(and(active, eq(d.organizationId, ref.scopeId)));
          break;
        case "HOTEL":
          rows = await tx.select({ id: d.id }).from(d).where(and(active, eq(d.hotelId, ref.scopeId)));
          break;
        case "GROUP":
          rows = await tx
            .select({ id: d.id })
            .from(d)
            .innerJoin(schema.roomGroupMembers, eq(schema.roomGroupMembers.roomId, d.roomId))
            .where(and(active, eq(schema.roomGroupMembers.groupId, ref.scopeId)));
          break;
        case "ROOM":
          rows = await tx.select({ id: d.id }).from(d).where(and(active, eq(d.roomId, ref.scopeId)));
          break;
        case "DEVICE":
          rows = [{ id: ref.scopeId }];
          break;
      }
      return rows.map((r) => r.id);
    });
  }

  /**
   * Recomputes every affected device. Sequential and in-process for now (bounded by hotel size);
   * GLOBAL/ORG fan-out moves to a BullMQ worker in Phase 7 (see PROGRESS.md).
   */
  async refreshScope(ref: ScopeRef): Promise<{ devices: number }> {
    const ids = await this.devicesForScope(ref);
    for (const id of ids) {
      try {
        await this.refreshDevice(id);
      } catch (e) {
        this.log.error(`policy refresh failed for device ${id}: ${(e as Error).message}`);
      }
    }
    return { devices: ids.length };
  }

  async latestSigned(deviceId: string): Promise<SignedPolicy | null> {
    return withTenant(this.db, SYSTEM, async (tx) => {
      const [row] = await tx
        .select({ signed: schema.effectivePolicies.signed })
        .from(schema.effectivePolicies)
        .where(eq(schema.effectivePolicies.deviceId, deviceId))
        .orderBy(desc(schema.effectivePolicies.version))
        .limit(1);
      return (row?.signed as SignedPolicy) ?? null;
    });
  }

  /** Decoded latest policy + explain, read through the caller's tenant context. */
  async latestDecoded(ctx: TenantContext, deviceId: string) {
    return withTenant(this.db, ctx, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.effectivePolicies)
        .where(eq(schema.effectivePolicies.deviceId, deviceId))
        .orderBy(desc(schema.effectivePolicies.version))
        .limit(1);
      if (!row) return null;
      const signed = row.signed as SignedPolicy;
      return {
        version: row.version,
        createdAt: row.createdAt,
        policy: EffectivePolicy.parse(JSON.parse(Buffer.from(signed.payload, "base64").toString("utf8"))),
        explain: row.explain as Record<string, unknown>,
        warnings: row.warnings,
      };
    });
  }
}
