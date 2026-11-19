import { DEFAULT_RESTRICTIONS } from "@hotel-os/protocol";
import type { PolicyConfig } from "./config";

export const LAUNCHER_PACKAGE = "com.hotelos.launcher";
export const IPTV_PACKAGE = "com.hotelos.iptv";
export const DPC_PACKAGE = "com.hotelos.dpc";

/** Packages that must never be suspended/hidden/uninstalled by policy. */
export const PROTECTED_PACKAGES: ReadonlySet<string> = new Set([
  DPC_PACKAGE,
  LAUNCHER_PACKAGE,
  "android",
  "com.android.systemui",
  "com.android.packageinstaller",
  "com.google.android.packageinstaller",
  "com.android.permissioncontroller",
  "com.google.android.permissioncontroller",
  "com.android.providers.settings",
]);

/** Implicit lowest layer. Secure by default: everything locked down, apps blocked unless allowed. */
export const BUILTIN_DEFAULTS: PolicyConfig = {
  kiosk: {
    mode: "ENFORCED_HOME",
    launcherPackage: LAUNCHER_PACKAGE,
    lockTaskExtraPackages: [],
    unlistedLaunchableApps: "SUSPENDED",
    systemPackagesToBlock: [
      "com.android.tv.settings",
      "com.android.vending",
      "com.google.android.tvlauncher",
      "com.google.android.apps.tv.launcherx",
      "com.google.android.katniss",
    ],
  },
  restrictions: Object.fromEntries(DEFAULT_RESTRICTIONS.map((r) => [r, true])),
  apps: {},
  launcher: {
    template: "classic",
    language: "en",
    availableLanguages: ["fr", "en", "he", "ar", "es", "it", "de"],
    branding: { hotelName: "Hotel", primaryColor: "#1F2937", accentColor: "#C8A96A" },
    welcomeMessage: {},
    modules: {},
    idleReturnHomeMinutes: 240,
  },
  system: {
    timezone: "Europe/Paris",
    autoTime: true,
    maintenanceWindow: { start: "03:00", end: "05:00" },
    telemetryIntervalSec: 300,
    screenCaptureDisabled: true,
  },
  iptv: { enabled: false },
  wifi: [],
};
