import { BadRequestException, ConflictException, ForbiddenException, GoneException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { type Db, schema, type TenantContext, withTenant } from "@hotel-os/db";
import type { DeviceStateReport, EnrollRequest, EnrollResponse } from "@hotel-os/protocol";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash, createPublicKey, randomBytes, randomInt } from "node:crypto";
import { AuditService } from "../common/audit.service";
import { DB } from "../common/db.module";
import { APP_CONFIG, type AppConfig } from "../config";
import { RolloutsService } from "../catalog/rollouts.service";
import { PolicyService } from "../policy/policy.service";
import { SigningService } from "../policy/signing.service";
import type { DevicePrincipal } from "./device-auth.service";

const SYSTEM: TenantContext = { orgIds: [], platform: true };
/** No 0/O/1/I/L: readable on a TV across a room. */
const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PAIRING_TTL_MIN = 15;

export const sha256hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

@Injectable()
export class DevicesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly signing: SigningService,
    private readonly rollouts: RolloutsService,
  ) {}

  async createEnrollmentToken(ctx: TenantContext, orgId: string, hotelId: string, maxUses: number, ttlHours: number, userId: string) {
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
    await withTenant(this.db, ctx, async (tx) => {
      const [row] = await tx.insert(schema.enrollmentTokens).values({ organizationId: orgId, hotelId, tokenHash: sha256hex(token), maxUses, expiresAt, createdBy: userId }).returning();
      await this.audit.log(tx, { organizationId: orgId, actorType: "USER", actorId: userId, action: "enrollment_token.create", targetType: "HOTEL", targetId: hotelId, data: { tokenId: row.id, maxUses, expiresAt } });
    });
    // The clear token is returned once and never stored.
    return { token, expiresAt, maxUses };
  }

  private newPairingCode() {
    return Array.from({ length: 6 }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join("");
  }

  async enroll(req: EnrollRequest, ip?: string): Promise<EnrollResponse> {
    if (!req.isDeviceOwner) throw new BadRequestException({ code: "NOT_DEVICE_OWNER", message: "HOTEL DEVICE CONTROLLER must be Device Owner before enrolling" });
    let spkiDer: Buffer;
    try {
      const k = createPublicKey({ key: Buffer.from(req.publicKey, "base64"), format: "der", type: "spki" });
      if (k.asymmetricKeyType !== "ec" || k.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("curve");
      spkiDer = k.export({ type: "spki", format: "der" });
    } catch {
      throw new BadRequestException({ code: "INVALID_PUBLIC_KEY", message: "expected EC P-256 SPKI (base64 DER)" });
    }
    const result = await withTenant(this.db, SYSTEM, async (tx) => {
      const [tok] = await tx.select().from(schema.enrollmentTokens).where(eq(schema.enrollmentTokens.tokenHash, sha256hex(req.enrollmentToken))).for("update");
      if (!tok) throw new ForbiddenException({ code: "INVALID_ENROLLMENT_TOKEN" });
      if (tok.expiresAt < new Date() || tok.uses >= tok.maxUses) throw new GoneException({ code: "ENROLLMENT_TOKEN_EXHAUSTED" });
      await tx.update(schema.enrollmentTokens).set({ uses: tok.uses + 1 }).where(eq(schema.enrollmentTokens.id, tok.id));

      // Hardware model registry: unknown models are recorded as PENDING certification.
      const hw = req.hardware;
      await tx.insert(schema.deviceModels).values({ manufacturer: hw.manufacturer, model: hw.model, androidVersion: hw.androidRelease, apiLevel: hw.sdkInt }).onConflictDoNothing();
      const [model] = await tx
        .select()
        .from(schema.deviceModels)
        .where(and(eq(schema.deviceModels.manufacturer, hw.manufacturer), eq(schema.deviceModels.model, hw.model)));

      const pairingCode = this.newPairingCode();
      const pairingExpiresAt = new Date(Date.now() + PAIRING_TTL_MIN * 60_000);
      const [device] = await tx
        .insert(schema.devices)
        .values({
          organizationId: tok.organizationId,
          hotelId: tok.hotelId,
          deviceModelId: model.id,
          hardware: hw,
          isDeviceOwner: true,
          versions: { dpc: req.dpcVersionCode },
          pairingCode,
          pairingExpiresAt,
          lastSeenAt: new Date(),
        })
        .returning();
      await tx.insert(schema.deviceCredentials).values({
        organizationId: tok.organizationId,
        deviceId: device.id,
        publicKeySpki: spkiDer.toString("base64"),
        fingerprint: sha256hex(spkiDer),
        attestation: req.attestationChain ? { chain: req.attestationChain, verified: false } : null,
      });
      await this.audit.log(tx, { organizationId: tok.organizationId, actorType: "DEVICE", actorId: device.id, action: "device.enroll", targetType: "HOTEL", targetId: tok.hotelId, data: { model: `${hw.manufacturer} ${hw.model}`, fingerprint: hw.buildFingerprint, modelStatus: model.status }, ip });
      return { device, pairingCode, pairingExpiresAt };
    });
    await this.policy.refreshDevice(result.device.id);
    return {
      deviceId: result.device.id,
      hotelId: result.device.hotelId,
      pairingCode: result.pairingCode,
      pairingExpiresAt: result.pairingExpiresAt.toISOString(),
      policyPublicKeys: [{ kid: this.signing.kid, spki: this.signing.publicKeySpki }],
      wsUrl: this.cfg.PUBLIC_WS_URL,
    };
  }

  /** A device not yet paired can ask for a fresh code (shown as QR on the TV). */
  async renewPairingCode(dev: DevicePrincipal) {
    if (dev.roomId) throw new ConflictException({ code: "ALREADY_PAIRED" });
    const pairingCode = this.newPairingCode();
    const pairingExpiresAt = new Date(Date.now() + PAIRING_TTL_MIN * 60_000);
    await withTenant(this.db, SYSTEM, (tx) => tx.update(schema.devices).set({ pairingCode, pairingExpiresAt }).where(eq(schema.devices.id, dev.deviceId)));
    return { pairingCode, pairingExpiresAt: pairingExpiresAt.toISOString() };
  }

  /**
   * Technician scans the QR on the TV and picks the room. If the room already has a device,
   * that device is REPLACED (credentials revoked); the room keeps its identity and configuration.
   */
  async pair(ctx: TenantContext, canPair: (orgId: string, hotelId: string) => boolean, pairingCode: string, roomId: string, userId: string) {
    const out = await withTenant(this.db, ctx, async (tx) => {
      const [device] = await tx.select().from(schema.devices).where(eq(schema.devices.pairingCode, pairingCode.toUpperCase()));
      if (!device || !device.pairingExpiresAt || device.pairingExpiresAt < new Date()) throw new NotFoundException({ code: "PAIRING_CODE_INVALID_OR_EXPIRED" });
      if (!canPair(device.organizationId, device.hotelId)) throw new ForbiddenException({ code: "FORBIDDEN", permission: "device:pair" });
      const [room] = await tx.select().from(schema.rooms).where(eq(schema.rooms.id, roomId));
      if (!room || room.hotelId !== device.hotelId) throw new BadRequestException({ code: "ROOM_NOT_IN_DEVICE_HOTEL" });

      const replaced = await tx
        .select()
        .from(schema.devices)
        .where(and(eq(schema.devices.roomId, room.id), inArray(schema.devices.status, ["ENROLLED", "ACTIVE"])));
      for (const old of replaced) {
        if (old.id === device.id) continue;
        await tx.update(schema.devices).set({ status: "REPLACED", roomId: null, updatedAt: new Date() }).where(eq(schema.devices.id, old.id));
        await tx.update(schema.deviceCredentials).set({ status: "REVOKED", revokedAt: new Date() }).where(eq(schema.deviceCredentials.deviceId, old.id));
        await tx.insert(schema.deviceRoomHistory).values({ organizationId: old.organizationId, deviceId: old.id, roomId: room.id, event: "REPLACED", actorId: userId });
      }
      await tx
        .update(schema.devices)
        .set({ roomId: room.id, status: "ACTIVE", pairingCode: null, pairingExpiresAt: null, updatedAt: new Date() })
        .where(eq(schema.devices.id, device.id));
      await tx.insert(schema.deviceRoomHistory).values({ organizationId: device.organizationId, deviceId: device.id, roomId: room.id, event: "PAIRED", actorId: userId });
      await this.audit.log(tx, { organizationId: device.organizationId, actorType: "USER", actorId: userId, action: "device.pair", targetType: "DEVICE", targetId: device.id, data: { roomId: room.id, roomNumber: room.number, replaced: replaced.filter((r) => r.id !== device.id).map((r) => r.id) } });
      return { deviceId: device.id, roomId: room.id, roomNumber: room.number, replacedDeviceIds: replaced.filter((r) => r.id !== device.id).map((r) => r.id) };
    });
    await this.policy.refreshDevice(out.deviceId);
    return out;
  }

  async revoke(ctx: TenantContext, orgId: string, deviceId: string, userId: string) {
    await withTenant(this.db, ctx, async (tx) => {
      await tx.update(schema.devices).set({ status: "REVOKED", roomId: null, updatedAt: new Date() }).where(eq(schema.devices.id, deviceId));
      await tx.update(schema.deviceCredentials).set({ status: "REVOKED", revokedAt: new Date() }).where(eq(schema.deviceCredentials.deviceId, deviceId));
      await this.audit.log(tx, { organizationId: orgId, actorType: "USER", actorId: userId, action: "device.revoke", targetType: "DEVICE", targetId: deviceId });
    });
  }

  /** Stores the observed state. Inventory is full (replace) or delta (upsert + removals). */
  async reportState(dev: DevicePrincipal, s: DeviceStateReport) {
    await withTenant(this.db, { orgIds: [dev.orgId] }, async (tx) => {
      const now = new Date();
      await tx
        .update(schema.devices)
        .set({
          isDeviceOwner: s.isDeviceOwner,
          kioskActive: s.kioskActive,
          launcherHealthy: s.launcherHealthy,
          policyVersionApplied: s.policyVersionApplied,
          reconcileErrors: s.reconcileErrors,
          versions: { dpc: s.dpcVersionCode, launcher: s.launcherVersionCode ?? null, iptv: s.iptvVersionCode ?? null },
          telemetry: { storageFreeMb: s.storageFreeMb, ramFreeMb: s.ramFreeMb, uptimeSec: s.uptimeSec, network: s.network, buildFingerprint: s.buildFingerprint },
          lastSeenAt: now,
          lastStateAt: now,
          updatedAt: now,
        })
        .where(eq(schema.devices.id, dev.deviceId));
      const inv = schema.deviceAppInventory;
      if (!s.inventoryIsDelta) await tx.delete(inv).where(eq(inv.deviceId, dev.deviceId));
      if (s.removedPackages.length) await tx.delete(inv).where(and(eq(inv.deviceId, dev.deviceId), inArray(inv.packageName, s.removedPackages)));
      if (s.apps.length) {
        await tx
          .insert(inv)
          .values(
            s.apps.map((a) => ({
              organizationId: dev.orgId,
              deviceId: dev.deviceId,
              packageName: a.packageName,
              label: a.label,
              versionCode: a.versionCode,
              versionName: a.versionName,
              system: a.system,
              enabled: a.enabled,
              suspended: a.suspended,
              hidden: a.hidden,
              hasLauncherEntry: a.hasLauncherEntry,
              signerSha256: a.signerSha256,
              canSuspend: a.canSuspend,
              canHide: a.canHide,
              observedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [inv.deviceId, inv.packageName],
            set: {
              label: sql`excluded.label`,
              versionCode: sql`excluded.version_code`,
              versionName: sql`excluded.version_name`,
              system: sql`excluded.system`,
              enabled: sql`excluded.enabled`,
              suspended: sql`excluded.suspended`,
              hidden: sql`excluded.hidden`,
              hasLauncherEntry: sql`excluded.has_launcher_entry`,
              signerSha256: sql`excluded.signer_sha256`,
              canSuspend: sql`coalesce(excluded.can_suspend, ${inv.canSuspend})`,
              canHide: sql`coalesce(excluded.can_hide, ${inv.canHide})`,
              observedAt: sql`excluded.observed_at`,
            },
          });
      }
    });
  }

  async touchAfterState(dev: DevicePrincipal, s: DeviceStateReport) {
    await this.rollouts.onDeviceState(dev.deviceId, s.apps, s.reconcileErrors, s.inventoryIsDelta);
  }

  async touch(deviceId: string) {
    await withTenant(this.db, SYSTEM, (tx) => tx.update(schema.devices).set({ lastSeenAt: new Date() }).where(eq(schema.devices.id, deviceId)));
  }
}
