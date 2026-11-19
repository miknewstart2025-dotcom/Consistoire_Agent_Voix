// Generates contract fixtures for android/dpc-core tests from the REAL TypeScript policy engine and
// signing code path (same algorithm as apps/api SigningService). Run: node scripts/gen-android-fixtures.mjs
import { createPublicKey, generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { resolveEffectivePolicy } = require("./../packages/policy-engine/dist/index.js");
const { EffectivePolicy } = require("./../packages/protocol/dist/index.js");

const out = new URL("../android/dpc-core/src/test/resources/fixtures/", import.meta.url);
mkdirSync(out, { recursive: true });
const deviceId = "0190a1b2-0000-7000-8000-00000000c0de";
const { policy } = resolveEffectivePolicy({
  deviceId,
  version: 3,
  issuedAt: new Date("2026-11-19T10:00:00Z"),
  layers: [
    { scopeType: "HOTEL", scopeId: "h", values: { apps: { "com.netflix.ninja": { state: "ALLOWED", order: 1, cleanup: "CLEAR_DATA" }, "com.google.android.youtube.tv": { state: "SUSPENDED", cleanup: "CLEAR_DATA" } }, iptv: { enabled: true }, launcher: { language: "he", welcomeMessage: { he: "ברוכים הבאים", fr: "Bienvenue" } } } },
    { scopeType: "ROOM", scopeId: "r", values: { launcher: { roomNumber: "201" } } },
  ],
  entitlements: { modules: ["iptv"] },
  capabilities: { lockTaskSupported: true, persistentHomeSupported: true },
  artifacts: { "com.hotelos.iptv": { versionCode: 12, versionName: "1.2.0", url: "https://cdn.example.test/iptv-12.apk", sha256: "a".repeat(64), signerSha256: "b".repeat(64), sizeBytes: 1234567 } },
});
EffectivePolicy.parse(policy);
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const kid = createHash("sha256").update(spki).digest("hex").slice(0, 16);
const bytes = Buffer.from(JSON.stringify(policy), "utf8");
const signed = { kid, alg: "ES256", payload: bytes.toString("base64"), signature: sign("sha256", bytes, { key: privateKey, dsaEncoding: "der" }).toString("base64"), version: policy.version };
writeFileSync(new URL("signed-policy.json", out), JSON.stringify(signed, null, 2));
writeFileSync(new URL("policy-key.json", out), JSON.stringify({ kid, spki: spki.toString("base64") }, null, 2));
writeFileSync(new URL("device-id.txt", out), deviceId);
writeFileSync(
  new URL("ws-frames.json", out),
  JSON.stringify([
    { t: "welcome", serverTime: "2026-11-19T10:00:00.000Z", latestPolicyVersion: 3 },
    { t: "policy.changed", version: 4 },
    { t: "command", command: { id: "0190a1b2-0000-7000-8000-0000000000c1", type: "SHOW_MESSAGE", payload: { text: "Bonjour", durationSec: 30, priority: "NORMAL" }, createdAt: "2026-11-19T10:00:00.000Z", expiresAt: "2026-11-20T10:00:00.000Z" } },
    { t: "error", code: "BAD_FRAME", message: "invalid message" },
  ], null, 2),
);
console.log("fixtures written");
