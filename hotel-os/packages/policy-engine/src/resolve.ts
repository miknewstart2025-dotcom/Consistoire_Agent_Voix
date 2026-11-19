import {
  type AppPolicy,
  type ApkArtifact,
  EffectivePolicy,
  type Language,
  type UserRestriction,
} from "@hotel-os/protocol";
import type { AppConfig, ConfigLayer, Entitlements, ModelCapabilities, PolicyConfig } from "./config";
import { BUILTIN_SCOPE_ID } from "./config";
import { BUILTIN_DEFAULTS, IPTV_PACKAGE, PROTECTED_PACKAGES } from "./defaults";
import { escapeSeg, mergeLayers, type Origin, unflatten } from "./merge";

export interface ResolveInput {
  deviceId: string;
  version: number;
  issuedAt: Date;
  layers: ConfigLayer[];
  entitlements: Entitlements;
  capabilities: ModelCapabilities;
  /** Resolved artifact per package for apps HOTEL OS installs (catalog / first-party). */
  artifacts: Record<string, ApkArtifact>;
}

export interface ResolveOutput {
  policy: EffectivePolicy;
  /** dotted path -> layer that set it (for "why is Netflix suspended in room 204?"). */
  explain: Record<string, Origin>;
  blocked: { path: string; by: Origin; lockedAt: Origin }[];
}

/** Modules gated by subscription. Launcher modules not listed here are always allowed. */
export const ENTITLED_MODULES = ["iptv", "room_service", "campaigns", "spa", "restaurant", "activities", "housekeeping", "pms"];

export function resolveEffectivePolicy(input: ResolveInput): ResolveOutput {
  const builtin: ConfigLayer = { scopeType: "GLOBAL", scopeId: BUILTIN_SCOPE_ID, priority: -1, values: BUILTIN_DEFAULTS };
  const merged = mergeLayers([builtin, ...input.layers]);
  const cfg = unflatten(merged.values) as PolicyConfig;
  const warnings: string[] = [];
  const entitled = new Set(input.entitlements.modules);
  const caps = input.capabilities;

  // ---- kiosk
  let kioskMode = cfg.kiosk!.mode!;
  if (kioskMode === "STRICT_LOCK_TASK" && !caps.lockTaskSupported) {
    warnings.push("kiosk.mode: STRICT_LOCK_TASK not supported by this model, falling back to ENFORCED_HOME");
    kioskMode = "ENFORCED_HOME";
  }
  if (!caps.persistentHomeSupported) {
    warnings.push("kiosk: persistent HOME not verified on this model – kiosk cannot be guaranteed");
  }

  // ---- modules & entitlements
  const modules: string[] = [];
  for (const [m, on] of Object.entries(cfg.launcher?.modules ?? {})) {
    if (!on) continue;
    if (ENTITLED_MODULES.includes(m) && !entitled.has(m)) {
      warnings.push(`launcher.modules.${m}: not included in subscription, disabled`);
      continue;
    }
    modules.push(m);
  }
  let iptvEnabled = cfg.iptv?.enabled ?? false;
  if (iptvEnabled && !entitled.has("iptv")) {
    warnings.push("iptv.enabled: not included in subscription, disabled");
    iptvEnabled = false;
  }

  // ---- apps
  const appsCfg: Record<string, AppConfig> = { ...(cfg.apps ?? {}) };
  if (iptvEnabled && !appsCfg[IPTV_PACKAGE]) {
    appsCfg[IPTV_PACKAGE] = { state: "ALLOWED", visibleInLauncher: true, order: 0, cleanup: "RESET_SESSION" };
  }
  if (!iptvEnabled && appsCfg[IPTV_PACKAGE]?.state === "ALLOWED") {
    appsCfg[IPTV_PACKAGE] = { ...appsCfg[IPTV_PACKAGE], state: "SUSPENDED" };
  }
  const apps: AppPolicy[] = [];
  for (const [pkg, a] of Object.entries(appsCfg)) {
    let state = a.state ?? "SUSPENDED";
    if (PROTECTED_PACKAGES.has(pkg) && state !== "ALLOWED") {
      warnings.push(`apps.${pkg}: protected package cannot be ${state}, kept ALLOWED`);
      state = "ALLOWED";
    }
    if (state === "SUSPENDED" && caps.canSuspend?.[pkg] === false) {
      warnings.push(
        caps.canHide?.[pkg] === false
          ? `apps.${pkg}: cannot be suspended nor hidden on this model – only removed from launcher`
          : `apps.${pkg}: cannot be suspended on this model – will be hidden instead`,
      );
      if (caps.canHide?.[pkg] !== false) state = "HIDDEN";
    }
    if (state === "HIDDEN" && caps.canHide?.[pkg] === false) {
      warnings.push(`apps.${pkg}: cannot be hidden on this model – only removed from launcher`);
    }
    const artifact = input.artifacts[pkg];
    if (pkg === IPTV_PACKAGE && state === "ALLOWED" && !artifact) {
      warnings.push(`apps.${pkg}: no published HOTEL IPTV artifact – it will only work if already installed`);
    }
    apps.push({
      packageName: pkg,
      state,
      visibleInLauncher: state === "ALLOWED" && (a.visibleInLauncher ?? true),
      order: a.order ?? 100,
      label: a.label,
      cleanup: a.cleanup ?? "KEEP",
      artifact: state === "UNINSTALLED" ? undefined : artifact,
    });
  }
  apps.sort((x, y) => x.order - y.order || x.packageName.localeCompare(y.packageName));

  // ---- restrictions
  const restrictions = Object.entries(cfg.restrictions ?? {})
    .filter(([, on]) => on === true)
    .map(([r]) => r as UserRestriction)
    .sort();

  // ---- launcher
  const l = cfg.launcher!;
  const language = l.language as Language;
  const available = l.availableLanguages ?? [language];
  if (!available.includes(language)) warnings.push(`launcher.language: ${language} not in availableLanguages`);

  const policy = EffectivePolicy.parse({
    schema: 1,
    deviceId: input.deviceId,
    version: input.version,
    issuedAt: input.issuedAt.toISOString(),
    kiosk: {
      mode: kioskMode,
      launcherPackage: cfg.kiosk!.launcherPackage,
      lockTaskExtraPackages: cfg.kiosk!.lockTaskExtraPackages ?? [],
      systemPackagesToBlock: (cfg.kiosk!.systemPackagesToBlock ?? []).filter((p) => !PROTECTED_PACKAGES.has(p)),
      unlistedLaunchableApps: cfg.kiosk!.unlistedLaunchableApps ?? "SUSPENDED",
    },
    restrictions,
    apps,
    launcher: {
      template: l.template,
      language,
      availableLanguages: available,
      timezone: cfg.system!.timezone,
      branding: l.branding,
      welcomeMessage: l.welcomeMessage ?? {},
      roomNumber: l.roomNumber,
      guestFirstName: l.guestFirstName,
      modules: modules.sort(),
      idleReturnHomeMinutes: l.idleReturnHomeMinutes,
    },
    system: {
      timezone: cfg.system!.timezone,
      autoTime: cfg.system!.autoTime,
      maintenanceWindow: cfg.system!.maintenanceWindow,
      telemetryIntervalSec: cfg.system!.telemetryIntervalSec,
      screenCaptureDisabled: cfg.system!.screenCaptureDisabled,
    },
    wifi: cfg.wifi ?? [],
    iptv: { enabled: iptvEnabled, lineupId: iptvEnabled ? cfg.iptv?.lineupId : undefined },
    warnings,
  });

  const explain: Record<string, Origin> = {};
  for (const [k, o] of merged.origin) explain[k] = o;
  return { policy, explain, blocked: merged.blocked };
}

/** Helper to build the dotted path of an app key (package names contain dots). */
export const appPath = (pkg: string, field: keyof AppConfig) => `apps.${escapeSeg(pkg)}.${field}`;
