import { describe, expect, it } from "vitest";
import { appPath, type ConfigLayer, type ModelCapabilities, resolveEffectivePolicy } from "./index";
import { flatten, splitPath, unflatten } from "./merge";

const DEVICE = "0190a1b2-0000-7000-8000-000000000001";
const fullCaps: ModelCapabilities = { lockTaskSupported: true, persistentHomeSupported: true };
const NETFLIX = "com.netflix.ninja";
const YOUTUBE = "com.google.android.youtube.tv";

const ART = { versionCode: 7, versionName: "7", url: "https://x/a.apk", sha256: "a".repeat(64), signerSha256: "b".repeat(64), sizeBytes: 1, updateWindow: "MAINTENANCE" as const };
function resolve(layers: ConfigLayer[], opts: Partial<{ caps: ModelCapabilities; modules: string[]; artifacts: Record<string, typeof ART> }> = {}) {
  return resolveEffectivePolicy({
    deviceId: DEVICE,
    version: 7,
    issuedAt: new Date("2026-11-19T10:00:00Z"),
    layers,
    entitlements: { modules: opts.modules ?? [] },
    capabilities: opts.caps ?? fullCaps,
    artifacts: opts.artifacts ?? {},
  });
}
const app = (r: ReturnType<typeof resolve>, pkg: string) => r.policy.apps.find((a) => a.packageName === pkg);

describe("path helpers", () => {
  it("round-trips package names containing dots", () => {
    const obj = { apps: { [NETFLIX]: { state: "ALLOWED" } }, a: { b: [1, 2] } };
    const m = new Map(flatten(obj));
    expect([...m.keys()]).toContain("apps.com\\.netflix\\.ninja.state");
    expect(splitPath("apps.com\\.netflix\\.ninja.state")).toEqual(["apps", NETFLIX, "state"]);
    expect(unflatten(m)).toEqual(obj);
  });
});

describe("resolveEffectivePolicy", () => {
  it("is secure by default with no layers", () => {
    const r = resolve([]);
    expect(r.policy.kiosk.mode).toBe("ENFORCED_HOME");
    expect(r.policy.restrictions).toContain("no_debugging_features");
    expect(r.policy.restrictions).toContain("no_install_unknown_sources");
    expect(r.policy.apps).toEqual([]);
    expect(r.policy.iptv.enabled).toBe(false);
    expect(r.policy.system.screenCaptureDisabled).toBe(true);
  });

  it("applies GLOBAL → HOTEL → GROUP → ROOM → DEVICE, most specific wins, key by key", () => {
    const r = resolve([
      { scopeType: "DEVICE", scopeId: "d", values: { launcher: { template: "device-tpl" } } },
      { scopeType: "HOTEL", scopeId: "h", values: { launcher: { template: "hotel-tpl", language: "fr" }, apps: { [NETFLIX]: { state: "ALLOWED", order: 1 } } } },
      { scopeType: "ROOM", scopeId: "r", values: { apps: { [NETFLIX]: { state: "SUSPENDED" } } } },
      { scopeType: "GROUP", scopeId: "g", values: { launcher: { language: "de" } } },
    ]);
    expect(r.policy.launcher.template).toBe("device-tpl");
    expect(r.policy.launcher.language).toBe("de");
    expect(app(r, NETFLIX)?.state).toBe("SUSPENDED");
    expect(app(r, NETFLIX)?.order).toBe(1); // inherited from HOTEL, not overwritten by ROOM
    expect(app(r, NETFLIX)?.visibleInLauncher).toBe(false);
    expect(r.explain[appPath(NETFLIX, "state")]).toEqual({ scopeType: "ROOM", scopeId: "r" });
    expect(r.explain[appPath(NETFLIX, "order")]).toEqual({ scopeType: "HOTEL", scopeId: "h" });
  });

  it("locked keys cannot be overridden by lower layers, and the attempt is reported", () => {
    const r = resolve([
      { scopeType: "GLOBAL", scopeId: "platform", values: { restrictions: { no_debugging_features: true } }, lockedKeys: ["restrictions.no_debugging_features"] },
      { scopeType: "HOTEL", scopeId: "h", values: { restrictions: { no_debugging_features: false, no_config_wifi: false } } },
    ]);
    expect(r.policy.restrictions).toContain("no_debugging_features");
    expect(r.policy.restrictions).not.toContain("no_config_wifi");
    expect(r.blocked).toEqual([
      { path: "restrictions.no_debugging_features", by: { scopeType: "HOTEL", scopeId: "h" }, lockedAt: { scopeType: "GLOBAL", scopeId: "platform" } },
    ]);
  });

  it("a locked prefix locks the whole subtree", () => {
    const r = resolve([
      { scopeType: "ORG", scopeId: "o", values: { launcher: { branding: { primaryColor: "#111111" } } }, lockedKeys: ["launcher.branding"] },
      { scopeType: "HOTEL", scopeId: "h", values: { launcher: { branding: { primaryColor: "#222222", accentColor: "#333333" } } } },
    ]);
    expect(r.policy.launcher.branding.primaryColor).toBe("#111111");
    expect(r.policy.launcher.branding.accentColor).toBe("#C8A96A");
    expect(r.blocked).toHaveLength(2);
  });

  it("between groups, higher priority wins", () => {
    const r = resolve([
      { scopeType: "GROUP", scopeId: "suites", priority: 10, values: { apps: { [NETFLIX]: { state: "ALLOWED" } } } },
      { scopeType: "GROUP", scopeId: "floor1", priority: 1, values: { apps: { [NETFLIX]: { state: "HIDDEN" } } } },
    ]);
    expect(app(r, NETFLIX)?.state).toBe("ALLOWED");
  });

  it("between groups of equal priority, most restrictive app state and restriction win (order independent)", () => {
    const g1: ConfigLayer = { scopeType: "GROUP", scopeId: "a", values: { apps: { [YOUTUBE]: { state: "SUSPENDED" } }, restrictions: { no_config_bluetooth: true } } };
    const g2: ConfigLayer = { scopeType: "GROUP", scopeId: "b", values: { apps: { [YOUTUBE]: { state: "ALLOWED" } }, restrictions: { no_config_bluetooth: false } } };
    for (const layers of [[g1, g2], [g2, g1]]) {
      const r = resolve(layers);
      expect(app(r, YOUTUBE)?.state).toBe("SUSPENDED");
      expect(r.policy.restrictions).toContain("no_config_bluetooth");
    }
  });

  it("a ROOM exception overrides any group", () => {
    const r = resolve([
      { scopeType: "GROUP", scopeId: "a", values: { apps: { [YOUTUBE]: { state: "SUSPENDED" } } } },
      { scopeType: "ROOM", scopeId: "204", values: { apps: { [YOUTUBE]: { state: "ALLOWED" } } } },
    ]);
    expect(app(r, YOUTUBE)?.state).toBe("ALLOWED");
  });

  it("modules and IPTV require entitlement", () => {
    const layers: ConfigLayer[] = [
      { scopeType: "HOTEL", scopeId: "h", values: { iptv: { enabled: true, lineupId: "0190a1b2-0000-7000-8000-0000000000aa" }, launcher: { modules: { room_service: true, weather: true } } } },
    ];
    const without = resolve(layers);
    expect(without.policy.iptv.enabled).toBe(false);
    expect(without.policy.launcher.modules).toEqual(["weather"]);
    expect(without.policy.warnings.some((w) => w.includes("iptv"))).toBe(true);

    const withSub = resolve(layers, { modules: ["iptv", "room_service"] });
    expect(withSub.policy.iptv.enabled).toBe(true);
    expect(withSub.policy.launcher.modules).toEqual(["room_service", "weather"]);
    expect(app(withSub, "com.hotelos.iptv")?.state).toBe("ALLOWED");
  });

  it("falls back when the hardware cannot enforce, with warnings", () => {
    const caps: ModelCapabilities = {
      lockTaskSupported: false,
      persistentHomeSupported: true,
      canSuspend: { [NETFLIX]: false, [YOUTUBE]: false },
      canHide: { [YOUTUBE]: false },
    };
    const r = resolve(
      [{ scopeType: "HOTEL", scopeId: "h", values: { kiosk: { mode: "STRICT_LOCK_TASK" }, apps: { [NETFLIX]: { state: "SUSPENDED" }, [YOUTUBE]: { state: "SUSPENDED" } } } }],
      { caps },
    );
    expect(r.policy.kiosk.mode).toBe("ENFORCED_HOME");
    expect(app(r, NETFLIX)?.state).toBe("HIDDEN");
    expect(app(r, YOUTUBE)?.state).toBe("SUSPENDED");
    expect(app(r, YOUTUBE)?.visibleInLauncher).toBe(false);
    expect(r.policy.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("never blocks protected packages", () => {
    const r = resolve([
      { scopeType: "HOTEL", scopeId: "h", values: { apps: { "com.hotelos.dpc": { state: "HIDDEN" } }, kiosk: { systemPackagesToBlock: ["com.hotelos.launcher", "com.android.vending"] } } },
    ]);
    expect(app(r, "com.hotelos.dpc")?.state).toBe("ALLOWED");
    expect(r.policy.kiosk.systemPackagesToBlock).toEqual(["com.android.vending"]);
  });

  it("arrays are replaced, not merged", () => {
    const r = resolve([
      { scopeType: "HOTEL", scopeId: "h", values: { launcher: { availableLanguages: ["fr", "en", "ar"] } } },
      { scopeType: "ROOM", scopeId: "r", values: { launcher: { availableLanguages: ["he", "en"], language: "he" } } },
    ]);
    expect(r.policy.launcher.availableLanguages).toEqual(["he", "en"]);
  });

  it("is deterministic regardless of input order", () => {
    const layers: ConfigLayer[] = [
      { scopeType: "GROUP", scopeId: "x", values: { launcher: { template: "x" } } },
      { scopeType: "GROUP", scopeId: "y", values: { launcher: { template: "y" } } },
      { scopeType: "HOTEL", scopeId: "h", values: { apps: { [NETFLIX]: { state: "ALLOWED" }, [YOUTUBE]: { state: "ALLOWED" } } } },
    ];
    const a = resolve(layers).policy;
    const b = resolve([...layers].reverse()).policy;
    expect(a).toEqual(b);
    expect(a.launcher.template).toBe("y");
  });

  it("deployed apps are allowed unless the hotel blocks them explicitly", () => {
    const r = resolve([{ scopeType: "HOTEL", scopeId: "h", values: { apps: { "com.blocked.app": { state: "SUSPENDED" } } } }], {
      artifacts: { "com.example.spa": ART, "com.blocked.app": ART },
    });
    expect(app(r, "com.example.spa")).toMatchObject({ state: "ALLOWED", visibleInLauncher: true, artifact: ART });
    expect(app(r, "com.blocked.app")).toMatchObject({ state: "SUSPENDED", artifact: ART });
  });
});
