import { EffectivePolicy, type SignedPolicy } from "@hotel-os/protocol";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, type Harness, insertUser, loginWithTotpSetup, startHarness, TestDeviceIdentity } from "./harness";

const fx = (n: string) => readFileSync(join(__dirname, "fixtures", n));
const V91 = fx("fixture-v91.apk");
const V92 = fx("fixture-v92.apk");
const OTHER = fx("fixture-other-signer-v93.apk");
const PKG = "io.appium.settings";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let h: Harness;
let admin: string;
let orgA: string;
let orgB: string;
let hotelId: string;
let orgAdminB: string;
let v91Id: string;
let v92Id: string;
const boxes: TestDeviceIdentity[] = [];

async function enroll(sdkInt = 34) {
  const { token } = (await h.http().post(`/v1/hotels/${hotelId}/enrollment-tokens`).set(bearer(admin)).send({}).expect(201)).body;
  const d = new TestDeviceIdentity();
  const body = d.enrollBody(token);
  body.hardware.sdkInt = sdkInt;
  d.deviceId = (await h.http().post("/device/v1/enroll").send(body).expect(201)).body.deviceId;
  return d;
}
async function policyOf(d: TestDeviceIdentity) {
  const s = (await h.http().get("/device/v1/policy").set(bearer(await d.token())).expect(200)).body as SignedPolicy;
  return EffectivePolicy.parse(JSON.parse(Buffer.from(s.payload, "base64").toString()));
}
async function report(d: TestDeviceIdentity, installed: number | null, error?: string) {
  const p = await policyOf(d);
  await h
    .http()
    .post("/device/v1/state")
    .set(bearer(await d.token()))
    .send({
      policyVersionApplied: p.version,
      reconcileErrors: error ? [{ key: `apps.${PKG}.install`, message: error }] : [],
      isDeviceOwner: true,
      kioskActive: true,
      launcherHealthy: true,
      dpcVersionCode: 1,
      apps: installed ? [{ packageName: PKG, versionCode: installed, system: false, enabled: true, suspended: false, hidden: false, hasLauncherEntry: false }] : [],
      inventoryIsDelta: false,
    })
    .expect(204);
}
const upload = (buf: Buffer, org: string | null, token = admin, attest = true) => {
  const r = h.http().post(`/v1/catalog/apks${org ? `?orgId=${org}` : ""}`).set(bearer(token)).set("Content-Type", "application/vnd.android.package-archive");
  if (attest) r.set("X-Distribution-Rights", "attested");
  return r.send(buf);
};

beforeAll(async () => {
  h = await startHarness({ STORAGE_DIR: `/tmp/claude-0/.hotelos-storage-${Date.now()}` /* dot-dir on purpose: regression for the default ".storage" */, PUBLIC_DOWNLOAD_BASE: "http://localhost/device/v1/apk/" });
  await insertUser(h, "root@platform.test", "correct horse battery", { platform: true });
  admin = (await loginWithTotpSetup(h, "root@platform.test", "correct horse battery")).token;
  orgA = (await h.http().post("/v1/organizations").set(bearer(admin)).send({ name: "A" }).expect(201)).body.id;
  orgB = (await h.http().post("/v1/organizations").set(bearer(admin)).send({ name: "B" }).expect(201)).body.id;
  hotelId = (await h.http().post(`/v1/organizations/${orgA}/hotels`).set(bearer(admin)).send({ name: "H" }).expect(201)).body.id;
  await h.http().post(`/v1/organizations/${orgB}/users`).set(bearer(admin)).send({ email: "b@b.test", name: "B", password: "b-admin-password", role: "ORG_ADMIN" }).expect(201);
  orgAdminB = (await loginWithTotpSetup(h, "b@b.test", "b-admin-password")).token;
  for (let i = 0; i < 4; i++) boxes.push(await enroll());
});
afterAll(async () => h?.close());

describe("APK catalog", () => {
  it("requires the distribution-rights attestation and a real signed APK", async () => {
    await upload(V91, orgA, admin, false).expect(400);
    const r = await upload(Buffer.from("PK not really"), orgA).expect(400);
    expect(r.body.code).toBe("APK_REJECTED");
  });

  it("analyses, stores byte-for-byte and pins the signer", async () => {
    const r = await upload(V91, orgA).expect(201);
    expect(r.body.analysis).toMatchObject({ packageName: PKG, versionCode: 91, sha256: sha(V91), signatureSchemes: [2] });
    v91Id = r.body.versionId;
    expect((await upload(V91, orgA).expect(409)).body.code).toBe("VERSION_EXISTS");
    expect((await upload(OTHER, orgA).expect(409)).body.code).toBe("SIGNER_MISMATCH");
    v92Id = (await upload(V92, orgA).expect(201)).body.versionId;
    const list = (await h.http().get(`/v1/catalog/apps?orgId=${orgA}`).set(bearer(admin)).expect(200)).body;
    expect(list[0].versions.map((v: { versionCode: number }) => v.versionCode)).toEqual([92, 91]);
  });

  it("isolates catalogs between organizations", async () => {
    await upload(V91, orgA, orgAdminB).expect(403);
    await h.http().get(`/v1/catalog/apps?orgId=${orgA}`).set(bearer(orgAdminB)).expect(403);
    await upload(V91, null, orgAdminB).expect(403); // platform catalog
    // B cannot deploy A's version to its own scope either
    await h.http().post("/v1/rollouts").set(bearer(orgAdminB)).send({ appVersionId: v91Id, scopeType: "ORG", scopeId: orgB }).expect(404);
  });
});

describe("progressive rollout", () => {
  let rolloutId: string;

  it("targets the first ring only and puts the APK in those devices' signed policy", async () => {
    const r = (await h.http().post("/v1/rollouts").set(bearer(admin)).send({ appVersionId: v91Id, scopeType: "HOTEL", scopeId: hotelId, rings: [25, 100], updateWindow: "IMMEDIATE" }).expect(201)).body;
    rolloutId = r.id;
    expect(r.counts).toMatchObject({ TARGETED: 1, WAITING: 3 });
    const targeted = boxes.filter((b) => r.targets.find((t: { deviceId: string; state: string }) => t.deviceId === b.deviceId && t.state === "TARGETED"));
    const waiting = boxes.filter((b) => !targeted.includes(b));
    const p = await policyOf(targeted[0]);
    const app = p.apps.find((a) => a.packageName === PKG)!;
    expect(app).toMatchObject({ state: "ALLOWED", visibleInLauncher: true });
    expect(app.artifact).toMatchObject({ versionCode: 91, sha256: sha(V91), updateWindow: "IMMEDIATE" });
    expect(app.artifact!.url).toMatch(new RegExp(`/device/v1/apk/${sha(V91)}$`));
    expect((await policyOf(waiting[0])).apps.find((a) => a.packageName === PKG)).toBeUndefined();

    // Download: only for devices whose policy contains the file; resumable.
    const path = new URL(app.artifact!.url).pathname;
    const dl = await h.http().get(path).set(bearer(await targeted[0].token())).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (x: Buffer) => c.push(x)); res.on("end", () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(sha(dl.body as Buffer)).toBe(sha(V91));
    const part = await h.http().get(path).set(bearer(await targeted[0].token())).set("Range", "bytes=100-").expect(206);
    expect(Number(part.headers["content-length"])).toBe(V91.length - 100);
    await h.http().get(path).set(bearer(await waiting[0].token())).expect(404);
    await h.http().get(path).expect(401);
  });

  it("measures success from device reports, advances rings and auto-pauses on failures", async () => {
    let r = (await h.http().get(`/v1/rollouts/${rolloutId}`).set(bearer(admin)).expect(200)).body;
    const t0 = r.targets.find((t: { state: string }) => t.state === "TARGETED").deviceId;
    await report(boxes.find((b) => b.deviceId === t0)!, 91);
    r = (await h.http().get(`/v1/rollouts/${rolloutId}`).set(bearer(admin)).expect(200)).body;
    expect(r).toMatchObject({ status: "RUNNING", currentRing: 0, counts: { SUCCEEDED: 1 } });

    r = (await h.http().post(`/v1/rollouts/${rolloutId}/advance`).set(bearer(admin)).expect(200)).body;
    expect(r.counts).toMatchObject({ TARGETED: 3, WAITING: 0 });
    const ring1 = boxes.filter((b) => b.deviceId !== t0);
    await report(ring1[0], null, "INSTALL_FAILED_INSUFFICIENT_STORAGE");
    r = (await h.http().get(`/v1/rollouts/${rolloutId}`).set(bearer(admin)).expect(200)).body;
    expect(r.status).toBe("PAUSED");
    expect(r.pausedReason).toMatch(/auto-paused: 1\/2/);

    // The failed box retries and succeeds later; the others succeed.
    await report(ring1[0], 91);
    await h.http().post(`/v1/rollouts/${rolloutId}/resume`).set(bearer(admin)).expect(200);
    await report(ring1[1], 91);
    await report(ring1[2], 91);
    r = (await h.http().get(`/v1/rollouts/${rolloutId}`).set(bearer(admin)).expect(200)).body;
    expect(r).toMatchObject({ status: "COMPLETED", counts: { SUCCEEDED: 4, FAILED: 0 } });
    const list = (await h.http().get(`/v1/catalog/apps?orgId=${orgA}`).set(bearer(admin)).expect(200)).body;
    expect(list[0].versions.find((v: { versionCode: number }) => v.versionCode === 91).status).toBe("PUBLISHED");
  });

  it("a box added after completion still receives the app; incompatible boxes are skipped", async () => {
    const late = await enroll();
    expect((await policyOf(late)).apps.find((a) => a.packageName === PKG)?.artifact?.versionCode).toBe(91);
    const old = await enroll(19); // APK minSdk is 21
    expect((await policyOf(old)).apps.find((a) => a.packageName === PKG)).toBeUndefined();
    boxes.push(late, old);
  });

  it("refuses downgrades (roll forward), lets the hotel block a deployed app, and cancel withdraws pending targets", async () => {
    const r = (await h.http().post("/v1/rollouts").set(bearer(admin)).send({ appVersionId: v92Id, scopeType: "HOTEL", scopeId: hotelId, rings: [100] }).expect(201)).body;
    expect(r.counts.SKIPPED_INCOMPATIBLE).toBe(1); // the API-19 box
    expect(r.targets.find((t: { message: string | null }) => t.message?.includes("API 21"))).toBeTruthy();
    const box = boxes[0];
    expect((await policyOf(box)).apps.find((a) => a.packageName === PKG)?.artifact).toMatchObject({ versionCode: 92, updateWindow: "MAINTENANCE" });

    await h.http().put(`/v1/config/HOTEL/${hotelId}`).set(bearer(admin)).send({ values: { apps: { [PKG]: { state: "SUSPENDED" } } } }).expect(200);
    expect((await policyOf(box)).apps.find((a) => a.packageName === PKG)?.state).toBe("SUSPENDED");
    await h.http().put(`/v1/config/HOTEL/${hotelId}`).set(bearer(admin)).send({ values: {} }).expect(200);

    await report(box, 92);
    await h.http().post(`/v1/rollouts/${r.id}/cancel`).set(bearer(admin)).expect(200);
    expect((await policyOf(box)).apps.find((a) => a.packageName === PKG)?.artifact?.versionCode).toBe(92); // already updated: kept
    expect((await policyOf(boxes[1])).apps.find((a) => a.packageName === PKG)?.artifact?.versionCode).toBe(91); // back to baseline

    // Rolling back by deploying an older version is impossible on Android → skipped with the reason.
    const back = (await h.http().post("/v1/rollouts").set(bearer(admin)).send({ appVersionId: v91Id, scopeType: "DEVICE", scopeId: box.deviceId, rings: [100] }).expect(201)).body;
    expect(back.targets[0]).toMatchObject({ state: "SKIPPED_INCOMPATIBLE", message: expect.stringMatching(/downgrade/) });
  });

  it("DEPLOY TO ALL HOTELS is platform-only, needs the explicit confirmation and a platform-catalog APK", async () => {
    await h.http().post("/v1/rollouts").set(bearer(orgAdminB)).send({ appVersionId: v91Id, scopeType: "ALL_HOTELS", confirm: "DEPLOY TO ALL HOTELS" }).expect(403);
    await h.http().post("/v1/rollouts").set(bearer(admin)).send({ appVersionId: v91Id, scopeType: "ALL_HOTELS" }).expect(400);
    const r = await h.http().post("/v1/rollouts").set(bearer(admin)).send({ appVersionId: v91Id, scopeType: "ALL_HOTELS", confirm: "DEPLOY TO ALL HOTELS" }).expect(400);
    expect(r.body.code).toBe("APP_NOT_IN_SCOPE_ORG");
  });

  it("validates rings", async () => {
    for (const rings of [[50, 25, 100], [5, 25], [0, 100]]) {
      await h.http().post("/v1/rollouts").set(bearer(admin)).send({ appVersionId: v92Id, scopeType: "ROOM", scopeId: "00000000-0000-4000-8000-000000000000", rings }).expect((res) => expect([400, 404]).toContain(res.status));
    }
  });
});
