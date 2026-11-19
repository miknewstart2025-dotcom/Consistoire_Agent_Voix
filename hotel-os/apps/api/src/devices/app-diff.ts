import type { AppDesiredState, EffectivePolicy } from "@hotel-os/protocol";

export interface InventoryRow {
  packageName: string;
  label: string | null;
  versionCode: number;
  system: boolean;
  suspended: boolean;
  hidden: boolean;
  canSuspend: boolean | null;
  canHide: boolean | null;
  hasLauncherEntry: boolean;
}

export interface AppDiffRow {
  packageName: string;
  label: string | null;
  system: boolean;
  installed: boolean;
  installedVersion: number | null;
  /** UNLISTED_DENIED: launchable app absent from policy, suspended by the deny-by-default rule. */
  desired: AppDesiredState | "UNMANAGED" | "UNLISTED_DENIED";
  targetVersion: number | null;
  visibleInLauncher: boolean;
  observedSuspended: boolean;
  observedHidden: boolean;
  /** Reality matches the desired state. */
  inSync: boolean;
  /** Hardware reported it cannot enforce the desired state. */
  notEnforceable: boolean;
}

/** Desired (policy) vs observed (device inventory). This is what the admin displays – never the intent alone. */
export function diffApps(policy: EffectivePolicy, inventory: InventoryRow[]): AppDiffRow[] {
  const inv = new Map(inventory.map((i) => [i.packageName, i]));
  const rows: AppDiffRow[] = [];
  const seen = new Set<string>();
  for (const a of policy.apps) {
    seen.add(a.packageName);
    const o = inv.get(a.packageName);
    const installed = !!o;
    let inSync: boolean;
    switch (a.state) {
      case "ALLOWED":
        inSync = installed && !o!.suspended && !o!.hidden && (!a.artifact || o!.versionCode >= a.artifact.versionCode);
        break;
      case "SUSPENDED":
        inSync = !installed || o!.suspended || o!.hidden;
        break;
      case "HIDDEN":
        inSync = !installed || o!.hidden;
        break;
      case "UNINSTALLED":
        inSync = !installed;
        break;
    }
    rows.push({
      packageName: a.packageName,
      label: o?.label ?? a.label ?? null,
      system: o?.system ?? false,
      installed,
      installedVersion: o?.versionCode ?? null,
      desired: a.state,
      targetVersion: a.artifact?.versionCode ?? null,
      visibleInLauncher: a.visibleInLauncher,
      observedSuspended: o?.suspended ?? false,
      observedHidden: o?.hidden ?? false,
      inSync,
      notEnforceable: (a.state === "SUSPENDED" && o?.canSuspend === false && o?.canHide === false) || (a.state === "HIDDEN" && o?.canHide === false),
    });
  }
  const denyUnlisted = policy.kiosk.unlistedLaunchableApps === "SUSPENDED";
  const exempt = new Set([policy.kiosk.launcherPackage, ...policy.kiosk.lockTaskExtraPackages, "com.hotelos.dpc"]);
  for (const o of inventory) {
    if (seen.has(o.packageName)) continue;
    if (denyUnlisted && o.hasLauncherEntry && !exempt.has(o.packageName)) {
      rows.push({
        packageName: o.packageName,
        label: o.label,
        system: o.system,
        installed: true,
        installedVersion: o.versionCode,
        desired: "UNLISTED_DENIED",
        targetVersion: null,
        visibleInLauncher: false,
        observedSuspended: o.suspended,
        observedHidden: o.hidden,
        inSync: o.suspended || o.hidden,
        notEnforceable: o.canSuspend === false && o.canHide === false,
      });
      continue;
    }
    rows.push({
      packageName: o.packageName,
      label: o.label,
      system: o.system,
      installed: true,
      installedVersion: o.versionCode,
      desired: "UNMANAGED",
      targetVersion: null,
      visibleInLauncher: false,
      observedSuspended: o.suspended,
      observedHidden: o.hidden,
      inSync: true,
      notEnforceable: false,
    });
  }
  return rows.sort((x, y) => (x.label ?? x.packageName).localeCompare(y.label ?? y.packageName));
}
