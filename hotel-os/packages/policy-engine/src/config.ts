import type {
  AppDesiredState,
  CleanupPolicy,
  KioskMode,
  Language,
  ScopeType,
  UserRestriction,
} from "@hotel-os/protocol";

/**
 * The editable configuration stored per layer (GLOBAL → ORG → HOTEL → GROUP → ROOM → DEVICE).
 * Everything that must merge key-by-key is a map, never an array: arrays are replaced wholesale.
 */
export interface AppConfig {
  state?: AppDesiredState;
  visibleInLauncher?: boolean;
  order?: number;
  label?: string;
  cleanup?: CleanupPolicy;
}

export interface PolicyConfig {
  kiosk?: {
    mode?: KioskMode;
    launcherPackage?: string;
    lockTaskExtraPackages?: string[];
    systemPackagesToBlock?: string[];
    unlistedLaunchableApps?: "SUSPENDED" | "UNMANAGED";
  };
  restrictions?: Partial<Record<UserRestriction, boolean>>;
  apps?: Record<string, AppConfig>;
  launcher?: {
    template?: string;
    language?: Language;
    availableLanguages?: Language[];
    branding?: {
      hotelName?: string;
      logoUrl?: string;
      backgroundUrl?: string;
      primaryColor?: string;
      accentColor?: string;
    };
    welcomeMessage?: Partial<Record<Language, string>>;
    roomNumber?: string;
    guestFirstName?: string;
    modules?: Record<string, boolean>;
    idleReturnHomeMinutes?: number;
  };
  system?: {
    timezone?: string;
    autoTime?: boolean;
    maintenanceWindow?: { start?: string; end?: string };
    telemetryIntervalSec?: number;
    screenCaptureDisabled?: boolean;
  };
  iptv?: { enabled?: boolean; lineupId?: string };
  wifi?: { ssid: string; security: "OPEN" | "WPA2" | "WPA3"; passphraseRef?: string }[];
}

export interface ConfigLayer {
  scopeType: ScopeType;
  scopeId: string;
  /** Only meaningful between GROUP layers: higher priority is applied later (wins). */
  priority?: number;
  values: PolicyConfig;
  /** Dotted paths (or prefixes) that lower layers may not override, e.g. "restrictions.no_debugging_features". */
  lockedKeys?: string[];
}

export interface ModelCapabilities {
  lockTaskSupported: boolean;
  persistentHomeSupported: boolean;
  /** Per package. Missing = unknown (assumed possible, the device will report reality). */
  canSuspend?: Record<string, boolean>;
  canHide?: Record<string, boolean>;
}

export interface Entitlements {
  /** Module keys the subscription includes, e.g. "iptv", "room_service", "campaigns". */
  modules: string[];
}

export const BUILTIN_SCOPE_ID = "builtin-defaults";
