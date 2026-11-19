import { z } from "zod";
import { AppDesiredState, CleanupPolicy, KioskMode, Language } from "./enums";

/** Android user restrictions the DPC knows how to apply (UserManager.DISALLOW_*). */
export const UserRestriction = z.enum([
  "no_install_apps",
  "no_install_unknown_sources",
  "no_install_unknown_sources_globally",
  "no_uninstall_apps",
  "no_factory_reset",
  "no_safe_boot",
  "no_debugging_features",
  "no_config_wifi",
  "no_config_bluetooth",
  "no_modify_accounts",
  "no_add_user",
  "no_physical_media",
  "no_usb_file_transfer",
  "no_config_date_time",
  "no_control_apps",
  "no_network_reset",
]);
export type UserRestriction = z.infer<typeof UserRestriction>;

export const DEFAULT_RESTRICTIONS: UserRestriction[] = [
  "no_install_apps",
  "no_install_unknown_sources",
  "no_install_unknown_sources_globally",
  "no_uninstall_apps",
  "no_factory_reset",
  "no_safe_boot",
  "no_debugging_features",
  "no_config_wifi",
  "no_modify_accounts",
  "no_add_user",
  "no_physical_media",
  "no_usb_file_transfer",
  "no_config_date_time",
  "no_control_apps",
  "no_network_reset",
];

export const ApkArtifact = z.object({
  versionCode: z.number().int().positive(),
  versionName: z.string(),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** SHA-256 of the signing certificate. Device refuses install if mismatched. */
  signerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
});
export type ApkArtifact = z.infer<typeof ApkArtifact>;

export const AppPolicy = z.object({
  packageName: z.string().min(1),
  state: AppDesiredState,
  /** Shown as a tile in the HOTEL LAUNCHER (only meaningful when state=ALLOWED). */
  visibleInLauncher: z.boolean(),
  order: z.number().int(),
  label: z.string().optional(),
  cleanup: CleanupPolicy,
  /** Present for apps HOTEL OS installs itself (catalog / first-party). */
  artifact: ApkArtifact.optional(),
});
export type AppPolicy = z.infer<typeof AppPolicy>;

export const LauncherPolicy = z.object({
  template: z.string(),
  language: Language,
  availableLanguages: z.array(Language),
  timezone: z.string(),
  branding: z.object({
    hotelName: z.string(),
    logoUrl: z.string().url().optional(),
    backgroundUrl: z.string().url().optional(),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  welcomeMessage: z.record(Language, z.string()).default({}),
  roomNumber: z.string().optional(),
  guestFirstName: z.string().optional(),
  modules: z.array(z.string()),
  idleReturnHomeMinutes: z.number().int().nonnegative(),
});
export type LauncherPolicy = z.infer<typeof LauncherPolicy>;

export const MaintenanceWindow = z.object({
  /** "HH:MM" in hotel local time. */
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

export const EffectivePolicy = z.object({
  schema: z.literal(1),
  deviceId: z.string().uuid(),
  version: z.number().int().positive(),
  issuedAt: z.string().datetime(),
  kiosk: z.object({
    mode: KioskMode,
    launcherPackage: z.string(),
    /** Extra packages allowed in lock task (helpers such as WebView / GMS) – strict mode only. */
    lockTaskExtraPackages: z.array(z.string()),
    /** Stock launcher / settings / store etc. to hide when the model allows it. */
    systemPackagesToBlock: z.array(z.string()),
    /**
     * What the DPC does with launchable apps (launcher entry) that the policy does not list.
     * SUSPENDED (default) = deny by default. UNMANAGED = leave as-is.
     */
    unlistedLaunchableApps: z.enum(["SUSPENDED", "UNMANAGED"]),
  }),
  restrictions: z.array(UserRestriction),
  apps: z.array(AppPolicy),
  launcher: LauncherPolicy,
  system: z.object({
    timezone: z.string(),
    autoTime: z.boolean(),
    maintenanceWindow: MaintenanceWindow,
    telemetryIntervalSec: z.number().int().min(30),
    screenCaptureDisabled: z.boolean(),
  }),
  wifi: z
    .array(z.object({ ssid: z.string(), security: z.enum(["OPEN", "WPA2", "WPA3"]), passphraseRef: z.string().optional() }))
    .default([]),
  iptv: z.object({ enabled: z.boolean(), lineupId: z.string().uuid().optional() }),
  /** Keys requested by config that this hardware model cannot enforce. Shown in admin. */
  warnings: z.array(z.string()),
});
export type EffectivePolicy = z.infer<typeof EffectivePolicy>;

/**
 * Signed envelope. `payload` is the base64 of the exact UTF-8 JSON bytes that were signed,
 * so the device verifies bytes before parsing (no canonicalisation needed on device).
 * Signature: ECDSA P-256 / SHA-256 (DER, base64). See docs/adr/0004-policy-signing.md.
 */
export const SignedPolicy = z.object({
  kid: z.string(),
  alg: z.literal("ES256"),
  payload: z.string(),
  signature: z.string(),
  version: z.number().int().positive(),
});
export type SignedPolicy = z.infer<typeof SignedPolicy>;
