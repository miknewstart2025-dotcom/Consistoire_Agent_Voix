import { createHash } from "node:crypto";
import { ATTR, attr, attrInt, attrStr, parseAxml, walk } from "./axml";
import { verifyApkSignature } from "./apk-signature";
import { extract, readZip } from "./zip";

export interface ApkAnalysis {
  packageName: string;
  versionCode: number;
  versionName: string;
  minSdk: number;
  targetSdk: number | null;
  permissions: string[];
  abis: string[];
  sha256: string;
  sizeBytes: number;
  signerSha256: string;
  signerSubject: string;
  signatureSchemes: number[];
  debuggable: boolean;
  /** Has an activity in category LEANBACK_LAUNCHER (shows on Android TV). */
  tvLauncher: boolean;
  label: string | null;
  warnings: string[];
}

const SENSITIVE = new Set([
  "android.permission.INSTALL_PACKAGES",
  "android.permission.REQUEST_INSTALL_PACKAGES",
  "android.permission.DELETE_PACKAGES",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.BIND_ACCESSIBILITY_SERVICE",
  "android.permission.BIND_DEVICE_ADMIN",
  "android.permission.WRITE_SECURE_SETTINGS",
  "android.permission.READ_LOGS",
  "android.permission.QUERY_ALL_PACKAGES",
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  "android.permission.ACCESS_FINE_LOCATION",
]);

/** Static analysis of an uploaded APK. Never modifies the file. Throws on anything Android would refuse. */
export function analyzeApk(apk: Buffer): ApkAnalysis {
  const z = readZip(apk);
  const manifestEntry = z.entries.find((e) => e.name === "AndroidManifest.xml");
  if (!manifestEntry) throw new Error("AndroidManifest.xml missing: not an APK");
  if (z.entries.some((e) => e.name.includes("..") || e.name.startsWith("/"))) throw new Error("suspicious path in archive");
  const m = parseAxml(extract(apk, manifestEntry, 4 * 1024 * 1024));
  if (m.name !== "manifest") throw new Error("root element is not <manifest>");
  const packageName = attrStr(m, "package");
  if (!packageName || !/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(packageName)) throw new Error("invalid package name");
  const low = attrInt(m, ATTR.versionCode);
  if (low === undefined) throw new Error("versionCode missing");
  const major = attrInt(m, ATTR.versionCodeMajor) ?? 0;
  const versionCode = major * 2 ** 32 + (low >>> 0);
  const versionName = attrStr(m, ATTR.versionName) ?? String(versionCode);
  let minSdk = 1;
  let targetSdk: number | null = null;
  const permissions: string[] = [];
  let debuggable = false;
  let tvLauncher = false;
  let label: string | null = null;
  for (const el of walk(m)) {
    if (el.name === "uses-sdk") {
      minSdk = attrInt(el, ATTR.minSdkVersion) ?? 1;
      targetSdk = attrInt(el, ATTR.targetSdkVersion) ?? null;
    } else if (el.name === "uses-permission" || el.name === "uses-permission-sdk-23") {
      const p = attrStr(el, ATTR.name);
      if (p) permissions.push(p);
    } else if (el.name === "application") {
      const d = attr(el, ATTR.debuggable);
      debuggable = d?.type === "bool" ? d.value : false;
      const l = attr(el, 0x01010001);
      label = l?.type === "string" ? l.value : null;
    } else if (el.name === "category" && attrStr(el, ATTR.name) === "android.intent.category.LEANBACK_LAUNCHER") {
      tvLauncher = true;
    }
  }
  const abis = [...new Set(z.entries.map((e) => /^lib\/([^/]+)\/[^/]+\.so$/.exec(e.name)?.[1]).filter((x): x is string => !!x))].sort();
  const sig = verifyApkSignature(apk, z);
  if (sig.signers.length !== 1) throw new Error(`expected exactly one signer, found ${sig.signers.length}`);
  const warnings: string[] = [];
  if (debuggable) warnings.push("APK is debuggable (android:debuggable=true): not suitable for production");
  if (/CN=Android Debug/.test(sig.signers[0].subject)) warnings.push("signed with an Android debug certificate");
  const sensitive = permissions.filter((p) => SENSITIVE.has(p));
  if (sensitive.length) warnings.push(`sensitive permissions: ${sensitive.join(", ")}`);
  if (!tvLauncher) warnings.push("no LEANBACK_LAUNCHER activity: the app may not be launchable on Android TV");
  if (targetSdk !== null && targetSdk < 28) warnings.push(`targetSdk ${targetSdk} is old`);
  return {
    packageName,
    versionCode,
    versionName,
    minSdk,
    targetSdk,
    permissions: permissions.sort(),
    abis,
    sha256: createHash("sha256").update(apk).digest("hex"),
    sizeBytes: apk.length,
    signerSha256: sig.signers[0].certSha256,
    signerSubject: sig.signers[0].subject,
    signatureSchemes: sig.schemes,
    debuggable,
    tvLauncher,
    label,
    warnings,
  };
}

/** Would Android install this APK on a device with these characteristics? */
export function compatibleWith(a: Pick<ApkAnalysis, "minSdk" | "abis">, device: { sdkInt?: number; supportedAbis?: string[] }): string | null {
  if (device.sdkInt !== undefined && device.sdkInt < a.minSdk) return `requires Android API ${a.minSdk}, device has ${device.sdkInt}`;
  if (a.abis.length && device.supportedAbis && !a.abis.some((x) => device.supportedAbis!.includes(x))) return `native code for ${a.abis.join("/")} only, device supports ${device.supportedAbis.join("/")}`;
  return null;
}
