import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, type Harness, insertUser, loginWithTotpSetup, startHarness, TestDeviceIdentity } from "./harness";

let h: Harness;
let admin: string;
let hotelId: string;
let feed: Server;
let feedUrl: string;
let playlist = "";
const dev = new TestDeviceIdentity();

const now = new Date();
const xt = (d: Date) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";
const epg = () => `<tv>
  <programme start="${xt(new Date(now.getTime() - 1800_000))}" stop="${xt(new Date(now.getTime() + 1800_000))}" channel="ch1"><title>En cours</title></programme>
  <programme start="${xt(new Date(now.getTime() + 1800_000))}" stop="${xt(new Date(now.getTime() + 5400_000))}" channel="ch1"><title>Ensuite</title></programme>
</tv>`;

beforeAll(async () => {
  feed = createServer((req, res) => {
    if (req.url === "/list.m3u") {
      if (req.headers.authorization !== `Basic ${Buffer.from("hotel:s3cret").toString("base64")}`) return res.writeHead(401).end();
      return res.end(playlist);
    }
    if (req.url === "/epg.xml") return res.end(epg());
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => feed.listen(0, "127.0.0.1", r));
  feedUrl = `http://127.0.0.1:${(feed.address() as AddressInfo).port}`;
  process.env.IPTV_ALLOW_PRIVATE_SOURCES = "true";
  h = await startHarness({ IPTV_ALLOW_PRIVATE_SOURCES: "true" });
  await insertUser(h, "root@platform.test", "correct horse battery", { platform: true });
  admin = (await loginWithTotpSetup(h, "root@platform.test", "correct horse battery")).token;
  const orgId = (await h.http().post("/v1/organizations").set(bearer(admin)).send({ name: "IPTV Org", modules: ["iptv"] }).expect(201)).body.id;
  hotelId = (await h.http().post(`/v1/organizations/${orgId}/hotels`).set(bearer(admin)).send({ name: "H" }).expect(201)).body.id;
  const { token } = (await h.http().post(`/v1/hotels/${hotelId}/enrollment-tokens`).set(bearer(admin)).send({}).expect(201)).body;
  dev.deviceId = (await h.http().post("/device/v1/enroll").send(dev.enrollBody(token)).expect(201)).body.deviceId;
});
afterAll(async () => {
  await h?.close();
  feed?.close();
});

describe("IPTV ingestion", () => {
  it("requires the broadcasting-rights attestation", async () => {
    await h.http().post(`/v1/hotels/${hotelId}/iptv/sources`).set(bearer(admin)).send({ name: "x", playlistUrl: `${feedUrl}/list.m3u` }).expect(400);
  });

  it("ingests playlist (with credentials) and EPG, never exposes credentials", async () => {
    playlist = `#EXTM3U\n#EXTINF:-1 tvg-id="ch1" group-title="Info",Canal 1\nhttp://s/1.m3u8\n#EXTINF:-1 tvg-chno="5",Canal 5\nudp://@239.1.1.5:1234\n`;
    const r = await h
      .http()
      .post(`/v1/hotels/${hotelId}/iptv/sources`)
      .set(bearer(admin))
      .send({ name: "Headend", playlistUrl: `${feedUrl}/list.m3u`, epgUrl: `${feedUrl}/epg.xml`, credentials: { username: "hotel", password: "s3cret" }, rightsAttestation: true })
      .expect(201);
    expect(r.body.sync).toMatchObject({ status: "OK", channels: 2, programmes: 2 });
    const sources = (await h.http().get(`/v1/hotels/${hotelId}/iptv/sources`).set(bearer(admin)).expect(200)).body;
    expect(sources[0]).toMatchObject({ hasCredentials: true, lastSyncStatus: "OK" });
    expect(JSON.stringify(sources)).not.toContain("s3cret");
    expect(sources[0].credentialsEnc).toBeUndefined();
    const ch = (await h.http().get(`/v1/hotels/${hotelId}/iptv/channels`).set(bearer(admin)).expect(200)).body;
    expect(ch.map((c: { number: number; name: string }) => [c.number, c.name])).toEqual([[1, "Canal 1"], [5, "Canal 5"]]);

    // Re-sync keeps numbers stable, removes vanished channels.
    playlist = `#EXTM3U\n#EXTINF:-1,Canal 5 renamed\nudp://@239.1.1.5:1234\n#EXTINF:-1,Canal 9\nhttp://s/9.m3u8\n`;
    const s2 = (await h.http().post(`/v1/iptv/sources/${sources[0].id}/sync`).set(bearer(admin)).expect(200)).body;
    expect(s2).toMatchObject({ status: "OK", channels: 2, removed: 1 });
    const ch2 = (await h.http().get(`/v1/hotels/${hotelId}/iptv/channels`).set(bearer(admin)).expect(200)).body;
    expect(ch2.map((c: { number: number; name: string }) => [c.number, c.name])).toEqual([[5, "Canal 5 renamed"], [6, "Canal 9"]]);
  });

  it("records failures instead of wiping the lineup", async () => {
    playlist = "<html>expired subscription</html>";
    const sources = (await h.http().get(`/v1/hotels/${hotelId}/iptv/sources`).set(bearer(admin)).expect(200)).body;
    const r = (await h.http().post(`/v1/iptv/sources/${sources[0].id}/sync`).set(bearer(admin)).expect(200)).body;
    expect(r).toMatchObject({ status: "FAILED" });
    expect((await h.http().get(`/v1/hotels/${hotelId}/iptv/channels`).set(bearer(admin)).expect(200)).body).toHaveLength(2);
  });

  it("serves lineup and EPG to devices only when IPTV is enabled by policy", async () => {
    const tok = async () => bearer(await dev.token());
    await h.http().get("/device/v1/iptv/lineup").set(await tok()).expect(403);
    await h.http().put(`/v1/config/HOTEL/${hotelId}`).set(bearer(admin)).send({ values: { iptv: { enabled: true } } }).expect(200);
    const lineup = (await h.http().get("/device/v1/iptv/lineup").set(await tok()).expect(200)).body;
    expect(lineup.channels.map((c: { number: number }) => c.number)).toEqual([5, 6]);
    expect((await h.http().get("/device/v1/iptv/epg?hours=999").set(await tok())).status).toBe(400);
    await h.http().get("/device/v1/iptv/epg?hours=12").set(await tok()).expect(200);
  });
});
