import { EffectivePolicy, type SignedPolicy } from "@hotel-os/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { SigningService } from "../src/policy/signing.service";
import { bearer, type Harness, insertUser, loginWithTotpSetup, startHarness, TestDeviceIdentity } from "./harness";

const NETFLIX = "com.netflix.ninja";
const YOUTUBE = "com.google.android.youtube.tv";
const FILES = "com.example.filemanager";

let h: Harness;
let admin: string;
let orgId: string;
let hotelId: string;
let rooms: Record<string, string>;
let groups: Record<string, string>;
const dev = new TestDeviceIdentity();
let policyKey: string;

const decode = (s: SignedPolicy) => EffectivePolicy.parse(JSON.parse(Buffer.from(s.payload, "base64").toString()));
async function devGet(path: string, status: number) {
  return h.http().get(path).set(bearer(await dev.token())).expect(status);
}
async function devPost(path: string, body: unknown, status: number) {
  return h.http().post(path).set(bearer(await dev.token())).send(body as object).expect(status);
}
async function fetchPolicy() {
  const r = await devGet("/device/v1/policy", 200);
  expect(SigningService.verify(r.body, policyKey)).toBe(true);
  return { signed: r.body as SignedPolicy, policy: decode(r.body), etag: r.headers.etag as string };
}
const inventory = (over: Partial<Record<string, { suspended?: boolean; hidden?: boolean }>> = {}) =>
  [NETFLIX, YOUTUBE, FILES, "com.hotelos.launcher", "com.hotelos.dpc"].map((p) => ({
    packageName: p,
    label: p.split(".").pop(),
    versionCode: 10,
    system: p !== FILES,
    enabled: true,
    suspended: over[p]?.suspended ?? false,
    hidden: over[p]?.hidden ?? false,
    hasLauncherEntry: p !== "com.hotelos.dpc",
    canSuspend: true,
    canHide: true,
  }));
const stateReport = (policyVersion: number, over = {}) => ({
  policyVersionApplied: policyVersion,
  reconcileErrors: [],
  isDeviceOwner: true,
  kioskActive: true,
  launcherHealthy: true,
  dpcVersionCode: 1,
  launcherVersionCode: 1,
  apps: inventory(over),
  inventoryIsDelta: false,
  storageFreeMb: 4000,
});

beforeAll(async () => {
  h = await startHarness();
  await insertUser(h, "root@platform.test", "correct horse battery", { platform: true });
  admin = (await loginWithTotpSetup(h, "root@platform.test", "correct horse battery")).token;
  orgId = (await h.http().post("/v1/organizations").set(bearer(admin)).send({ name: "Grand Hotels", modules: ["iptv", "room_service"] }).expect(201)).body.id;
  hotelId = (await h.http().post(`/v1/organizations/${orgId}/hotels`).set(bearer(admin)).send({ name: "Le Grand Hôtel", timezone: "Europe/Paris", defaultLanguage: "fr", languages: ["fr", "en", "he", "ar"] }).expect(201)).body.id;
  const imp = await h
    .http()
    .post(`/v1/hotels/${hotelId}/rooms/import`)
    .set(bearer(admin))
    .send({ csv: "number,floor,type,groups\n101,1,standard,Étage 1\n102,1,standard,Étage 1\n201,2,suite,Étage 2|Suites\n,2,bad,\n" })
    .expect(201);
  expect(imp.body).toMatchObject({ created: 3, updated: 0 });
  expect(imp.body.errors).toHaveLength(1);
  const rr = (await h.http().get(`/v1/hotels/${hotelId}/rooms`).set(bearer(admin)).expect(200)).body as { id: string; number: string }[];
  rooms = Object.fromEntries(rr.map((r) => [r.number, r.id]));
  const gg = (await h.http().get(`/v1/hotels/${hotelId}/groups`).set(bearer(admin)).expect(200)).body as { id: string; name: string }[];
  groups = Object.fromEntries(gg.map((g) => [g.name, g.id]));
});
afterAll(async () => h?.close());

describe("device lifecycle", () => {
  it("rejects enrollment without a valid token or Device Owner", async () => {
    await h.http().post("/device/v1/enroll").send(dev.enrollBody("x".repeat(32))).expect(403);
    const { token } = (await h.http().post(`/v1/hotels/${hotelId}/enrollment-tokens`).set(bearer(admin)).send({ maxUses: 1 }).expect(201)).body;
    await h.http().post("/device/v1/enroll").send({ ...dev.enrollBody(token), isDeviceOwner: false }).expect(400);
    await h.http().post("/device/v1/enroll").send({ ...dev.enrollBody(token), publicKey: "Zm9vYmFyYmF6".repeat(5) }).expect(400);
  });

  it("enrolls with a single-use token and gets a pairing code", async () => {
    const { token } = (await h.http().post(`/v1/hotels/${hotelId}/enrollment-tokens`).set(bearer(admin)).send({ maxUses: 1 }).expect(201)).body;
    const r = await h.http().post("/device/v1/enroll").send(dev.enrollBody(token)).expect(201);
    dev.deviceId = r.body.deviceId;
    policyKey = r.body.policyPublicKeys[0].spki;
    expect(r.body.pairingCode).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(r.body.hotelId).toBe(hotelId);
    // token is single-use
    await h.http().post("/device/v1/enroll").send(new TestDeviceIdentity().enrollBody(token)).expect(410);
    // unknown model recorded for certification
    const models = (await h.http().get("/v1/device-models").set(bearer(admin)).expect(200)).body;
    expect(models).toContainEqual(expect.objectContaining({ manufacturer: "TestCorp", model: "TestBox 4K", status: "PENDING" }));
  });

  it("authenticates the device with its own key only", async () => {
    await h.http().get("/device/v1/policy").expect(401);
    const impostor = new TestDeviceIdentity();
    impostor.deviceId = dev.deviceId;
    await h.http().get("/device/v1/policy").set(bearer(await impostor.token())).expect(401);
    await h.http().get("/device/v1/policy").set(bearer(await dev.token(3600))).expect(401); // TTL too long
  });

  it("serves a signed, secure-by-default policy before pairing", async () => {
    const { policy } = await fetchPolicy();
    expect(policy.deviceId).toBe(dev.deviceId);
    expect(policy.kiosk.mode).toBe("ENFORCED_HOME"); // unknown model → no strict mode claims
    expect(policy.kiosk.unlistedLaunchableApps).toBe("SUSPENDED");
    expect(policy.restrictions).toContain("no_debugging_features");
    expect(policy.warnings.join(" ")).toMatch(/persistent HOME not verified/);
    expect(policy.launcher.branding.hotelName).toBe("Le Grand Hôtel");
    expect(policy.launcher.roomNumber).toBeUndefined();
  });

  it("pairs to a room by code and gets room-specific policy", async () => {
    const code = (await devPost("/device/v1/pairing-code", {}, 200)).body.pairingCode;
    const r = await h.http().post("/v1/devices/pair").set(bearer(admin)).send({ pairingCode: code, roomId: rooms["201"] }).expect(200);
    expect(r.body).toMatchObject({ roomNumber: "201", replacedDeviceIds: [] });
    const { policy } = await fetchPolicy();
    expect(policy.launcher.roomNumber).toBe("201");
    await devPost("/device/v1/pairing-code", {}, 409);
  });

  it("resolves HOTEL → GROUP → ROOM config, versions the policy and supports ETag", async () => {
    await h.http().put(`/v1/config/HOTEL/${hotelId}`).set(bearer(admin)).send({ values: { apps: { [NETFLIX]: { state: "ALLOWED", order: 1, cleanup: "CLEAR_DATA" }, [YOUTUBE]: { state: "ALLOWED", order: 2, cleanup: "CLEAR_DATA" } }, iptv: { enabled: true } } }).expect(200);
    const put = await h.http().put(`/v1/config/GROUP/${groups["Suites"]}`).set(bearer(admin)).send({ values: { apps: { [YOUTUBE]: { state: "SUSPENDED" } }, launcher: { welcomeMessage: { fr: "Bienvenue dans votre suite" } } } }).expect(200);
    expect(put.body.devicesRecomputed).toBe(1);
    const { policy, etag } = await fetchPolicy();
    const app = (p: string) => policy.apps.find((a) => a.packageName === p);
    expect(app(NETFLIX)).toMatchObject({ state: "ALLOWED", visibleInLauncher: true, cleanup: "CLEAR_DATA" });
    expect(app(YOUTUBE)).toMatchObject({ state: "SUSPENDED", visibleInLauncher: false });
    expect(app("com.hotelos.iptv")).toMatchObject({ state: "ALLOWED" });
    expect(policy.launcher.welcomeMessage.fr).toBe("Bienvenue dans votre suite");
    await h.http().get("/device/v1/policy").set(bearer(await dev.token())).set("If-None-Match", etag).expect(304);

    const eff = await h.http().get(`/v1/devices/${dev.deviceId}/effective-policy`).set(bearer(admin)).expect(200);
    expect(eff.body.explain["apps.com\\.google\\.android\\.youtube\\.tv.state"]).toEqual({ scopeType: "GROUP", scopeId: groups["Suites"] });

    // Unchanged config → no new version.
    const before = policy.version;
    await h.http().put(`/v1/config/GROUP/${groups["Suites"]}`).set(bearer(admin)).send({ values: { apps: { [YOUTUBE]: { state: "SUSPENDED" } }, launcher: { welcomeMessage: { fr: "Bienvenue dans votre suite" } } } }).expect(200);
    expect((await fetchPolicy()).policy.version).toBe(before);
  });

  it("rejects invalid configuration", async () => {
    await h.http().put(`/v1/config/HOTEL/${hotelId}`).set(bearer(admin)).send({ values: { apps: { "not a package": { state: "ALLOWED" } } } }).expect(400);
    await h.http().put(`/v1/config/HOTEL/${hotelId}`).set(bearer(admin)).send({ values: { kiosk: { mode: "OFF" } } }).expect(400);
    await h.http().put(`/v1/config/HOTEL/${hotelId}`).set(bearer(admin)).send({ values: { unknownKey: 1 } }).expect(400);
  });

  it("shows desired vs observed reality, including enforcement gaps", async () => {
    const { policy } = await fetchPolicy();
    // Device has applied the policy but YouTube is NOT actually suspended yet, and FILES (unlisted) is not blocked.
    await devPost("/device/v1/state", stateReport(policy.version), 204);
    let detail = (await h.http().get(`/v1/devices/${dev.deviceId}`).set(bearer(admin)).expect(200)).body;
    const row = (p: string) => detail.apps.find((a: { packageName: string }) => a.packageName === p);
    expect(detail.policy.inSync).toBe(true);
    expect(row(NETFLIX)).toMatchObject({ desired: "ALLOWED", installed: true, inSync: true });
    expect(row(YOUTUBE)).toMatchObject({ desired: "SUSPENDED", observedSuspended: false, inSync: false });
    expect(row(FILES)).toMatchObject({ desired: "UNLISTED_DENIED", inSync: false });
    expect(row("com.hotelos.iptv")).toMatchObject({ desired: "ALLOWED", installed: false, inSync: false });

    await devPost("/device/v1/state", stateReport(policy.version, { [YOUTUBE]: { suspended: true }, [FILES]: { suspended: true } }), 204);
    detail = (await h.http().get(`/v1/devices/${dev.deviceId}`).set(bearer(admin)).expect(200)).body;
    expect(row(YOUTUBE).inSync).toBe(true);
    expect(row(FILES).inSync).toBe(true);

    const table = (await h.http().get(`/v1/hotels/${hotelId}/apps`).set(bearer(admin)).expect(200)).body;
    expect(table.devices).toBe(1);
    expect(table.apps.find((a: { packageName: string }) => a.packageName === YOUTUBE)).toMatchObject({ installed: 1, allowed: 0, visible: 0, suspended: 1, mismatched: 0 });
    expect(table.apps.find((a: { packageName: string }) => a.packageName === NETFLIX)).toMatchObject({ installed: 1, allowed: 1, visible: 1 });
  });

  it("delivers commands by polling with an auditable lifecycle", async () => {
    const cmd = (await h.http().post(`/v1/devices/${dev.deviceId}/commands`).set(bearer(admin)).send({ type: "SHOW_MESSAGE", payload: { text: "Votre taxi est arrivé" }, idempotencyKey: "msg-1" }).expect(201)).body;
    const again = (await h.http().post(`/v1/devices/${dev.deviceId}/commands`).set(bearer(admin)).send({ type: "SHOW_MESSAGE", payload: { text: "Votre taxi est arrivé" }, idempotencyKey: "msg-1" }).expect(201)).body;
    expect(again.id).toBe(cmd.id);
    await h.http().post(`/v1/devices/${dev.deviceId}/commands`).set(bearer(admin)).send({ type: "SHOW_MESSAGE", payload: { text: "x", evil: true } }).expect(400);
    await h.http().post(`/v1/devices/${dev.deviceId}/commands`).set(bearer(admin)).send({ type: "CHECKOUT_CLEANUP" }).expect(403);

    const polled = (await devGet("/device/v1/commands", 200)).body;
    expect(polled.map((c: { id: string }) => c.id)).toContain(cmd.id);
    await devPost(`/device/v1/commands/${cmd.id}/result`, { status: "ACKED" }, 200);
    await devPost(`/device/v1/commands/${cmd.id}/result`, { status: "SUCCEEDED", message: "displayed" }, 200);
    const late = await devPost(`/device/v1/commands/${cmd.id}/result`, { status: "RUNNING" }, 200);
    expect(late.body.applied).toBe(false); // no going back from a terminal state
    const full = (await h.http().get(`/v1/commands/${cmd.id}`).set(bearer(admin)).expect(200)).body;
    expect(full.status).toBe("SUCCEEDED");
    expect(full.events.map((e: { status: string }) => e.status)).toEqual(["QUEUED", "DELIVERED", "ACKED", "SUCCEEDED"]);
  });

  it("pushes policy changes and commands over WebSocket", async () => {
    const ws = new WebSocket(`${h.baseUrl.replace("http", "ws")}/device/v1/ws`, { headers: bearer(await dev.token()) });
    const frames: { t: string; [k: string]: unknown }[] = [];
    const waitFor = (pred: (f: { t: string; [k: string]: unknown }) => boolean, ms = 5000) =>
      new Promise<{ t: string; [k: string]: unknown }>((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          const f = frames.find(pred);
          if (f) return resolve(f);
          if (Date.now() - t0 > ms) return reject(new Error(`timeout; frames=${JSON.stringify(frames)}`));
          setTimeout(tick, 20);
        };
        tick();
      });
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    await waitFor((f) => f.t === "welcome");
    ws.send(JSON.stringify({ t: "hello", policyVersion: 0, protocol: 1 }));
    await waitFor((f) => f.t === "policy.changed");

    const cmd = (await h.http().post(`/v1/devices/${dev.deviceId}/commands`).set(bearer(admin)).send({ type: "REFRESH_UI" }).expect(201)).body;
    const pushed = await waitFor((f) => f.t === "command" && (f.command as { id: string }).id === cmd.id);
    expect((pushed.command as { type: string }).type).toBe("REFRESH_UI");
    ws.send(JSON.stringify({ t: "command.update", commandId: cmd.id, result: { status: "SUCCEEDED" } }));
    await new Promise((r) => setTimeout(r, 200));
    expect((await h.http().get(`/v1/commands/${cmd.id}`).set(bearer(admin)).expect(200)).body.status).toBe("SUCCEEDED");

    const list = (await h.http().get(`/v1/hotels/${hotelId}/devices`).set(bearer(admin)).expect(200)).body;
    expect(list[0]).toMatchObject({ id: dev.deviceId, online: true, roomNumber: "201" });

    frames.length = 0;
    await h.http().put(`/v1/config/ROOM/${rooms["201"]}`).set(bearer(admin)).send({ values: { launcher: { template: "premium" } } }).expect(200);
    await waitFor((f) => f.t === "policy.changed");
    ws.send("not json");
    await waitFor((f) => f.t === "error");
    ws.close();

    const anon = new WebSocket(`${h.baseUrl.replace("http", "ws")}/device/v1/ws`);
    await new Promise<void>((resolve) => anon.on("error", () => resolve()).on("unexpected-response", () => resolve()));
  });

  it("check-in personalises, check-out cleans up with a report", async () => {
    await h.http().post(`/v1/rooms/${rooms["201"]}/check-in`).set(bearer(admin)).send({ guestFirstName: "Sarah", displayNameConsent: true, language: "he" }).expect(201);
    await h.http().post(`/v1/rooms/${rooms["201"]}/check-in`).set(bearer(admin)).send({}).expect(409);
    let { policy } = await fetchPolicy();
    expect(policy.launcher).toMatchObject({ guestFirstName: "Sarah", language: "he" });

    const out = (await h.http().post(`/v1/rooms/${rooms["201"]}/check-out`).set(bearer(admin)).expect(200)).body;
    expect(out.cleanupJobs).toHaveLength(1);
    ({ policy } = await fetchPolicy());
    expect(policy.launcher.guestFirstName).toBeUndefined();
    expect(policy.launcher.language).toBe("fr");

    const cmds = (await devGet("/device/v1/commands", 200)).body as { id: string; type: string; payload: { cleanupJobId: string; apps: { packageName: string; action: string }[] } }[];
    const cleanup = cmds.find((c) => c.type === "CHECKOUT_CLEANUP")!;
    expect(cleanup.payload.cleanupJobId).toBe(out.cleanupJobs[0]);
    expect(cleanup.payload.apps).toEqual(
      expect.arrayContaining([
        { packageName: NETFLIX, action: "CLEAR_DATA" },
        { packageName: "com.hotelos.iptv", action: "RESET_SESSION" },
      ]),
    );
    await devPost(`/device/v1/cleanup/${cleanup.payload.cleanupJobId}/report`, {
      outcome: "PARTIAL",
      apps: [
        { packageName: NETFLIX, action: "CLEAR_DATA", ok: true },
        { packageName: YOUTUBE, action: "CLEAR_DATA", ok: false, message: "package protected by system" },
      ],
      finishedAt: new Date().toISOString(),
    }, 200);
    const stays = (await h.http().get(`/v1/rooms/${rooms["201"]}/stays`).set(bearer(admin)).expect(200)).body;
    expect(stays[0]).toMatchObject({ status: "CHECKED_OUT" });
    expect(stays[0].cleanupJobs[0]).toMatchObject({ status: "PARTIAL" });
    expect((await h.http().get(`/v1/commands/${cleanup.id}`).set(bearer(admin)).expect(200)).body.status).toBe("SUCCEEDED");
  });

  it("does not store the guest name without consent", async () => {
    const s = (await h.http().post(`/v1/rooms/${rooms["101"]}/check-in`).set(bearer(admin)).send({ guestFirstName: "Marc", displayNameConsent: false }).expect(201)).body;
    expect(s.guestFirstName).toBeNull();
  });

  it("replaces a broken box: room keeps its config, old box is revoked", async () => {
    const { token } = (await h.http().post(`/v1/hotels/${hotelId}/enrollment-tokens`).set(bearer(admin)).send({}).expect(201)).body;
    const fresh = new TestDeviceIdentity();
    const r = await h.http().post("/device/v1/enroll").send(fresh.enrollBody(token)).expect(201);
    fresh.deviceId = r.body.deviceId;
    const pair = await h.http().post("/v1/devices/pair").set(bearer(admin)).send({ pairingCode: r.body.pairingCode, roomId: rooms["201"] }).expect(200);
    expect(pair.body.replacedDeviceIds).toEqual([dev.deviceId]);
    await h.http().get("/device/v1/policy").set(bearer(await dev.token())).expect(401);
    const p = decode((await h.http().get("/device/v1/policy").set(bearer(await fresh.token())).expect(200)).body);
    expect(p.launcher.template).toBe("premium"); // ROOM config survived the swap
    expect(p.apps.find((a) => a.packageName === YOUTUBE)?.state).toBe("SUSPENDED");
  });
});
