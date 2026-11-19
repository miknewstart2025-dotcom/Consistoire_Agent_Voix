import { createDb, schema, withTenant } from "@hotel-os/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, type Harness, insertUser, loginWithTotpSetup, startHarness, totpNow } from "./harness";

let h: Harness;
let platform: string;
let orgA: string;
let orgB: string;
let hotelA: string;
let hotelB: string;

beforeAll(async () => {
  h = await startHarness();
  await insertUser(h, "root@platform.test", "correct horse battery", { platform: true });
  platform = (await loginWithTotpSetup(h, "root@platform.test", "correct horse battery")).token;
  orgA = (await h.http().post("/v1/organizations").set(bearer(platform)).send({ name: "Org A", modules: ["iptv"] }).expect(201)).body.id;
  orgB = (await h.http().post("/v1/organizations").set(bearer(platform)).send({ name: "Org B" }).expect(201)).body.id;
  hotelA = (await h.http().post(`/v1/organizations/${orgA}/hotels`).set(bearer(platform)).send({ name: "Hotel A" }).expect(201)).body.id;
  hotelB = (await h.http().post(`/v1/organizations/${orgB}/hotels`).set(bearer(platform)).send({ name: "Hotel B" }).expect(201)).body.id;
});
afterAll(async () => h?.close());

describe("admin authentication", () => {
  it("forces TOTP enrolment, then requires TOTP at every login", async () => {
    await insertUser(h, "alice@a.test", "alice-password-1");
    const { totpSecret } = await loginWithTotpSetup(h, "alice@a.test", "alice-password-1");
    const noTotp = await h.http().post("/v1/auth/login").send({ email: "alice@a.test", password: "alice-password-1" }).expect(200);
    expect(noTotp.body).toEqual({ ok: true, totpRequired: true });
    const ok = await h.http().post("/v1/auth/login").send({ email: "alice@a.test", password: "alice-password-1", totp: totpNow(totpSecret) }).expect(200);
    expect(ok.body.accessToken).toBeTypeOf("string");
    await h.http().post("/v1/auth/login").send({ email: "alice@a.test", password: "alice-password-1", totp: "000000" }).expect(401);
  });

  it("locks the account after 5 failures", async () => {
    await insertUser(h, "bob@a.test", "bob-password-12");
    for (let i = 0; i < 5; i++) await h.http().post("/v1/auth/login").send({ email: "bob@a.test", password: "wrong" }).expect(401);
    await h.http().post("/v1/auth/login").send({ email: "bob@a.test", password: "bob-password-12" }).expect(403);
  });

  it("rejects missing or forged tokens", async () => {
    await h.http().get("/v1/hotels").expect(401);
    await h.http().get("/v1/hotels").set(bearer("x.y.z")).expect(401);
  });

  it("only platform admins create organizations", async () => {
    await h.http().post(`/v1/organizations/${orgA}/users`).set(bearer(platform)).send({ email: "orga@a.test", name: "A admin", password: "orga-password-1", role: "ORG_ADMIN" }).expect(201);
    const { token } = await loginWithTotpSetup(h, "orga@a.test", "orga-password-1");
    await h.http().post("/v1/organizations").set(bearer(token)).send({ name: "Nope" }).expect(403);
  });
});

describe("tenant isolation", () => {
  let tokenA: string;
  beforeAll(async () => {
    await h.http().post(`/v1/organizations/${orgA}/users`).set(bearer(platform)).send({ email: "admin2@a.test", name: "A2", password: "admin2-password", role: "ORG_ADMIN" }).expect(201);
    tokenA = (await loginWithTotpSetup(h, "admin2@a.test", "admin2-password")).token;
  });

  it("lists only own hotels", async () => {
    const r = await h.http().get("/v1/hotels").set(bearer(tokenA)).expect(200);
    expect(r.body.map((x: { id: string }) => x.id)).toEqual([hotelA]);
  });

  it("foreign hotel is invisible (404), not merely forbidden", async () => {
    await h.http().get(`/v1/hotels/${hotelB}`).set(bearer(tokenA)).expect(404);
    await h.http().post(`/v1/hotels/${hotelB}/rooms`).set(bearer(tokenA)).send({ number: "101" }).expect(404);
    await h.http().post(`/v1/hotels/${hotelB}/enrollment-tokens`).set(bearer(tokenA)).send({}).expect(404);
    await h.http().get(`/v1/config/HOTEL/${hotelB}`).set(bearer(tokenA)).expect(404);
  });

  it("cannot create a hotel in another org or write GLOBAL config", async () => {
    await h.http().post(`/v1/organizations/${orgB}/hotels`).set(bearer(tokenA)).send({ name: "x" }).expect(404);
    await h.http().put("/v1/config/GLOBAL/global").set(bearer(tokenA)).send({ values: {} }).expect(403);
  });

  it("RLS blocks cross-tenant reads even if application code forgot a filter", async () => {
    const { db, pool } = createDb({ connectionString: h.appDbUrl });
    try {
      const seenByA = await withTenant(db, { orgIds: [orgA] }, (tx) => tx.select().from(schema.hotels));
      expect(seenByA.map((x) => x.id)).toEqual([hotelA]);
      const none = await withTenant(db, { orgIds: [] }, (tx) => tx.select().from(schema.hotels));
      expect(none).toEqual([]);
      await expect(withTenant(db, { orgIds: [orgA] }, (tx) => tx.insert(schema.rooms).values({ organizationId: orgB, hotelId: hotelB, number: "666" }))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
    } finally {
      await pool.end();
    }
  });

  it("hotel-scoped roles stay within their hotel and their permissions", async () => {
    const hotelA2 = (await h.http().post(`/v1/organizations/${orgA}/hotels`).set(bearer(platform)).send({ name: "Hotel A2" }).expect(201)).body.id;
    await h.http().post(`/v1/organizations/${orgA}/users`).set(bearer(platform)).send({ email: "tech@a.test", name: "Tech", password: "tech-password-1", role: "TECHNICIAN", hotelId: hotelA }).expect(201);
    const tech = (await loginWithTotpSetup(h, "tech@a.test", "tech-password-1")).token;
    const room = (await h.http().post(`/v1/hotels/${hotelA}/rooms`).set(bearer(platform)).send({ number: "101" }).expect(201)).body.id;
    await h.http().get(`/v1/hotels/${hotelA}/rooms`).set(bearer(tech)).expect(200);
    await h.http().get(`/v1/hotels/${hotelA2}/rooms`).set(bearer(tech)).expect(403);
    // Technicians never see guest data.
    await h.http().get(`/v1/rooms/${room}/stays`).set(bearer(tech)).expect(403);
    await h.http().post(`/v1/rooms/${room}/check-in`).set(bearer(tech)).send({}).expect(403);
  });
});
