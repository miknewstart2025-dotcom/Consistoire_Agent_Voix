/**
 * Provisioning station logic (ADB). Pure step planning + output interpretation, so it is unit-tested
 * without a device; cli.ts executes the steps with the real `adb` binary. [HW-REQUIRED] for real runs.
 *
 * Preconditions on the box (see docs/PROVISIONING.md): factory reset, setup wizard completed WITHOUT
 * adding any Google account, developer options + USB/network debugging enabled.
 */
export const DPC_PACKAGE = "com.hotelos.dpc";
export const DPC_ADMIN = `${DPC_PACKAGE}/.HotelDeviceAdminReceiver`;

export interface Step {
  name: string;
  args: string[];
  /** Returns an error message when the output means failure. */
  check?: (out: string) => string | null;
}

export function plan(opts: { serial?: string; dpcApk: string; launcherApk?: string; serverUrl: string; token: string }): Step[] {
  const adb = (...a: string[]) => (opts.serial ? ["-s", opts.serial, ...a] : a);
  const steps: Step[] = [
    { name: "device reachable", args: adb("get-state"), check: (o) => (o.trim() === "device" ? null : `adb state is "${o.trim()}" (authorize the USB debugging prompt on the TV)`) },
    { name: "no accounts on device", args: adb("shell", "dumpsys", "account"), check: checkNoAccounts },
    { name: "no secondary users", args: adb("shell", "pm", "list", "users"), check: (o) => ((o.match(/UserInfo\{/g) ?? []).length > 1 ? "secondary users exist: factory reset required" : null) },
    { name: "install controller", args: adb("install", "-r", "-g", opts.dpcApk), check: (o) => (/Success/.test(o) ? null : `install failed: ${o.trim()}`) },
  ];
  if (opts.launcherApk) steps.push({ name: "install launcher", args: adb("install", "-r", opts.launcherApk), check: (o) => (/Success/.test(o) ? null : `install failed: ${o.trim()}`) });
  steps.push(
    { name: "set Device Owner", args: adb("shell", "dpm", "set-device-owner", DPC_ADMIN), check: checkSetDeviceOwner },
    {
      name: "configure server + enrollment token",
      args: adb("shell", "am", "broadcast", "-a", "com.hotelos.dpc.CONFIGURE", "-n", `${DPC_PACKAGE}/.ProvisioningConfigReceiver`, "--es", "serverUrl", opts.serverUrl, "--es", "enrollmentToken", opts.token),
      check: (o) => (/result=200/.test(o) ? null : `controller refused configuration: ${o.trim()}`),
    },
    { name: "verify Device Owner", args: adb("shell", "dumpsys", "device_policy"), check: (o) => (o.includes(DPC_PACKAGE) ? null : "Device Owner not reported by dumpsys device_policy") },
  );
  return steps;
}

export function checkNoAccounts(out: string): string | null {
  const m = /Accounts:\s*(\d+)/.exec(out);
  if (!m) return null; // format varies across versions: set-device-owner will fail explicitly anyway
  return Number(m[1]) > 0 ? `${m[1]} account(s) present: factory reset and skip Google sign-in during setup` : null;
}

export function checkSetDeviceOwner(out: string): string | null {
  if (/Success: Device owner set/i.test(out) || /Active admin set/i.test(out) && /owner/i.test(out)) return null;
  if (/already (some )?accounts/i.test(out)) return "accounts present on the device: factory reset, skip Google sign-in";
  if (/already (been )?provisioned|already (has|set up)/i.test(out)) return "device already provisioned: factory reset required (or firmware forbids Device Owner after setup)";
  if (/Unknown admin|not found/i.test(out)) return "controller APK not installed correctly";
  return `set-device-owner failed: ${out.trim()} — this model may not support Device Owner (mark it INCOMPATIBLE)`;
}
