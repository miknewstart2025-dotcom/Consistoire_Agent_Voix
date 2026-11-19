import { z } from "zod";

/** Version of the device <-> server protocol. Bump on breaking change. */
export const PROTOCOL_VERSION = 1;

export const SUPPORTED_LANGUAGES = ["fr", "en", "he", "ar", "es", "it", "de"] as const;
export const Language = z.enum(SUPPORTED_LANGUAGES);
export type Language = z.infer<typeof Language>;
export const RTL_LANGUAGES: ReadonlySet<Language> = new Set(["he", "ar"]);

/** Desired state of an application on a device. Order matters: later = more restrictive. */
export const APP_STATES = ["ALLOWED", "SUSPENDED", "HIDDEN", "UNINSTALLED"] as const;
export const AppDesiredState = z.enum(APP_STATES);
export type AppDesiredState = z.infer<typeof AppDesiredState>;
export const APP_STATE_RESTRICTIVENESS: Record<AppDesiredState, number> = {
  ALLOWED: 0,
  SUSPENDED: 1,
  HIDDEN: 2,
  UNINSTALLED: 3,
};

export const KioskMode = z.enum(["ENFORCED_HOME", "STRICT_LOCK_TASK"]);
export type KioskMode = z.infer<typeof KioskMode>;

/** What to do with an app's local data at checkout. */
export const CleanupPolicy = z.enum(["KEEP", "CLEAR_DATA", "RESET_SESSION"]);
export type CleanupPolicy = z.infer<typeof CleanupPolicy>;

export const AppSource = z.enum(["NATIVE", "CATALOG", "FIRST_PARTY"]);
export type AppSource = z.infer<typeof AppSource>;

export const ScopeType = z.enum(["GLOBAL", "ORG", "HOTEL", "GROUP", "ROOM", "DEVICE"]);
export type ScopeType = z.infer<typeof ScopeType>;
export const SCOPE_ORDER: Record<ScopeType, number> = {
  GLOBAL: 0,
  ORG: 1,
  HOTEL: 2,
  GROUP: 3,
  ROOM: 4,
  DEVICE: 5,
};

export const CommandType = z.enum([
  "REBOOT_DEVICE",
  "RESTART_LAUNCHER",
  "LAUNCH_APP",
  "REFRESH_UI",
  "SYNC_NOW",
  "SHOW_MESSAGE",
  "CHECKOUT_CLEANUP",
  "UPLOAD_LOGS",
  "RUN_DIAGNOSTICS",
  "INSTALL_APP",
  "UNINSTALL_APP",
  "EMERGENCY_BROADCAST",
  "ENTER_MAINTENANCE",
  "RUN_CERTIFICATION",
]);
export type CommandType = z.infer<typeof CommandType>;

export const CommandStatus = z.enum([
  "QUEUED",
  "DELIVERED",
  "ACKED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
]);
export type CommandStatus = z.infer<typeof CommandStatus>;
export const TERMINAL_COMMAND_STATUSES: ReadonlySet<CommandStatus> = new Set([
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
]);

export const CleanupOutcome = z.enum(["SUCCEEDED", "PARTIAL", "FAILED"]);
export type CleanupOutcome = z.infer<typeof CleanupOutcome>;

export const CertificationStatus = z.enum(["CERTIFIED", "PARTIAL", "INCOMPATIBLE", "PENDING"]);
export type CertificationStatus = z.infer<typeof CertificationStatus>;
