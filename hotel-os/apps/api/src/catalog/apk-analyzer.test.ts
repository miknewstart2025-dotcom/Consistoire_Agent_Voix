import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeApk, compatibleWith } from "./apk-analyzer";
import { readSigningBlock, V2_ID } from "./apk-signature";
import { readZip } from "./zip";

// Real APK (io.appium.settings 5.12.0, Apache-2.0, from the npm package `io.appium.settings`).
// Expected values were produced independently with Google's apksig 2.3.0 (ApkVerifier + AndroidBinXmlParser).
const apk = readFileSync(join(__dirname, "../../test/fixtures/settings_apk-debug.apk"));

describe("analyzeApk on a real APK", () => {
  const a = analyzeApk(apk);
  it("reads the binary manifest like apksig does", () => {
    expect(a.packageName).toBe("io.appium.settings");
    expect(a.versionCode).toBe(90);
    expect(a.versionName).toBe("5.12.0");
    expect(a.minSdk).toBe(21);
    expect(a.targetSdk).toBe(32);
    expect(a.permissions).toHaveLength(21);
    expect(a.permissions).toContain("android.permission.INTERNET");
  });
  it("verifies the v2 signature and extracts the same signer as apksig", () => {
    expect(a.signatureSchemes).toEqual([2]);
    expect(a.signerSha256).toBe("197addb8d0432ed5a1eb539ecb56f43f2f5afa3f52af91616d5de313541fd56d");
    expect(a.signerSubject).toMatch(/CN=Android Debug/);
    expect(a.warnings.join(" ")).toMatch(/debug certificate/);
    expect(a.warnings.join(" ")).toMatch(/LEANBACK_LAUNCHER/);
  });
  it("checks device compatibility", () => {
    expect(compatibleWith(a, { sdkInt: 28, supportedAbis: ["arm64-v8a"] })).toBeNull();
    expect(compatibleWith({ minSdk: 30, abis: [] }, { sdkInt: 28 })).toMatch(/API 30/);
    expect(compatibleWith({ minSdk: 21, abis: ["x86_64"] }, { sdkInt: 34, supportedAbis: ["arm64-v8a", "armeabi-v7a"] })).toMatch(/native code/);
  });
});

describe("analyzeApk rejects tampered or invalid files", () => {
  it("detects a single modified byte inside a ZIP entry", () => {
    const z = readZip(apk);
    const e = z.entries.find((x) => x.name === "classes.dex")!;
    const t = Buffer.from(apk);
    const dataStart = e.localHeaderOffset + 30 + t.readUInt16LE(e.localHeaderOffset + 26) + t.readUInt16LE(e.localHeaderOffset + 28);
    t[dataStart + 100] ^= 0xff;
    expect(() => analyzeApk(t)).toThrow(/content digest mismatch/);
  });
  it("detects a tampered signed-data block", () => {
    const t = Buffer.from(apk);
    const block = readSigningBlock(t, readZip(t))!;
    const v2 = block.pairs.get(V2_ID)!;
    // v2 value → signers seq (4) → signer (4) → signed data (4) → digests seq (4) → digest (4) → alg (4) → digest bytes
    t[v2.byteOffset - t.byteOffset + 28] ^= 0x01;
    expect(() => analyzeApk(t)).toThrow(/signature does not verify/);
  });
  it("ignores unsigned padding in the signing block, like Android", () => {
    const t = Buffer.from(apk);
    const block = readSigningBlock(t, readZip(t))!;
    const pad = block.pairs.get(0x42726577);
    if (!pad) return; // no verity padding in this APK
    t[pad.byteOffset - t.byteOffset] ^= 0x01;
    expect(analyzeApk(t).packageName).toBe("io.appium.settings");
  });
  it("refuses non-APK input", () => {
    expect(() => analyzeApk(Buffer.from("hello"))).toThrow(/ZIP/);
  });
});
