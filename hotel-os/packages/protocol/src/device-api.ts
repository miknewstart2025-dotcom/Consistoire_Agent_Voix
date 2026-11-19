import { z } from "zod";
import { CleanupOutcome, CommandStatus, CommandType } from "./enums";

export const HardwareInfo = z.object({
  manufacturer: z.string(),
  model: z.string(),
  brand: z.string().optional(),
  buildFingerprint: z.string(),
  sdkInt: z.number().int(),
  androidRelease: z.string(),
  supportedAbis: z.array(z.string()),
  serial: z.string().optional(),
  androidId: z.string().optional(),
  /** Informational only – never used as identity. */
  macAddress: z.string().optional(),
  ramMb: z.number().int().optional(),
  storageTotalMb: z.number().int().optional(),
});
export type HardwareInfo = z.infer<typeof HardwareInfo>;

export const EnrollRequest = z.object({
  enrollmentToken: z.string().min(16),
  /** SPKI DER base64 of the device's EC P-256 public key (generated in Android Keystore). */
  publicKey: z.string().min(40),
  /** Key attestation certificate chain (base64 DER), if the device supports it. */
  attestationChain: z.array(z.string()).optional(),
  hardware: HardwareInfo,
  dpcVersionCode: z.number().int(),
  isDeviceOwner: z.boolean(),
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;

export const EnrollResponse = z.object({
  deviceId: z.string().uuid(),
  hotelId: z.string().uuid(),
  pairingCode: z.string(),
  pairingExpiresAt: z.string().datetime(),
  policyPublicKeys: z.array(z.object({ kid: z.string(), spki: z.string() })),
  wsUrl: z.string(),
});
export type EnrollResponse = z.infer<typeof EnrollResponse>;

export const ObservedApp = z.object({
  packageName: z.string(),
  label: z.string().optional(),
  versionCode: z.number().int(),
  versionName: z.string().optional(),
  system: z.boolean(),
  enabled: z.boolean(),
  suspended: z.boolean(),
  hidden: z.boolean(),
  hasLauncherEntry: z.boolean(),
  signerSha256: z.string().optional(),
  iconHash: z.string().optional(),
  /** Measured by actually trying (and reading back) on this device. */
  canSuspend: z.boolean().optional(),
  canHide: z.boolean().optional(),
});
export type ObservedApp = z.infer<typeof ObservedApp>;

export const DeviceStateReport = z.object({
  policyVersionApplied: z.number().int().nonnegative(),
  reconcileErrors: z.array(z.object({ key: z.string(), message: z.string() })),
  isDeviceOwner: z.boolean(),
  kioskActive: z.boolean(),
  launcherHealthy: z.boolean(),
  dpcVersionCode: z.number().int(),
  launcherVersionCode: z.number().int().optional(),
  iptvVersionCode: z.number().int().optional(),
  /** Full inventory, or only changed packages when `inventoryIsDelta`. */
  apps: z.array(ObservedApp),
  inventoryIsDelta: z.boolean(),
  removedPackages: z.array(z.string()).default([]),
  storageFreeMb: z.number().int().optional(),
  ramFreeMb: z.number().int().optional(),
  uptimeSec: z.number().int().optional(),
  network: z.object({ type: z.enum(["ETHERNET", "WIFI", "NONE", "OTHER"]), ssid: z.string().optional(), ip: z.string().optional() }).optional(),
  buildFingerprint: z.string().optional(),
});
export type DeviceStateReport = z.infer<typeof DeviceStateReport>;

export const DeviceCommand = z.object({
  id: z.string().uuid(),
  type: CommandType,
  payload: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type DeviceCommand = z.infer<typeof DeviceCommand>;

export const CommandResult = z.object({
  status: z.enum(["ACKED", "RUNNING", "SUCCEEDED", "FAILED"]),
  message: z.string().optional(),
  data: z.record(z.unknown()).optional(),
});
export type CommandResult = z.infer<typeof CommandResult>;

export const CleanupAppResult = z.object({
  packageName: z.string(),
  action: z.enum(["CLEAR_DATA", "RESET_SESSION", "KEEP"]),
  ok: z.boolean(),
  message: z.string().optional(),
});
export const CleanupReport = z.object({
  outcome: CleanupOutcome,
  apps: z.array(CleanupAppResult),
  finishedAt: z.string().datetime(),
});
export type CleanupReport = z.infer<typeof CleanupReport>;

/** WebSocket frames (JSON, one per message). */
export const WsClientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), policyVersion: z.number().int().nonnegative(), protocol: z.number().int() }),
  z.object({ t: z.literal("heartbeat") }),
  z.object({ t: z.literal("command.update"), commandId: z.string().uuid(), result: CommandResult }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;

export const WsServerMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("welcome"), serverTime: z.string().datetime(), latestPolicyVersion: z.number().int().nonnegative() }),
  z.object({ t: z.literal("policy.changed"), version: z.number().int() }),
  z.object({ t: z.literal("command"), command: DeviceCommand }),
  z.object({ t: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessage>;

export { CommandStatus };
