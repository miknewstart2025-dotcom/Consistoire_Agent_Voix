/**
 * Integration harness: real PostgreSQL (infra/dev-postgres.sh), fresh database per test file,
 * migrations applied with the owner role, API connected with the RLS-restricted app role.
 */
import { createDb, runMigrations, schema, withTenant } from "@hotel-os/db";
import type { INestApplication } from "@nestjs/common";
import { generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { Secret, TOTP } from "otpauth";
import { Client } from "pg";
import request from "supertest";
import { AuthService } from "../src/auth/auth.service";
import { createApp } from "../src/bootstrap";
import { loadConfig } from "../src/config";

const HOST = process.env.TEST_PG_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TEST_PG_PORT ?? 54329);
const SUPER = `postgres://postgres@${HOST}:${PORT}/postgres`;

export interface Harness {
  app: INestApplication;
  baseUrl: string;
  dbName: string;
  appDbUrl: string;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function startHarness(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const dbName = `hotelos_test_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: SUPER });
  await admin.connect();
  await admin.query(`create database ${dbName} owner hotelos_owner`);
  await admin.end();
  await runMigrations({ connectionString: `postgres://hotelos_owner:hotelos_owner@${HOST}:${PORT}/${dbName}` });
  const appDbUrl = `postgres://hotelos_api:hotelos_api@${HOST}:${PORT}/${dbName}`;
  const cfg = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: appDbUrl,
    JWT_SECRET: randomBytes(32).toString("hex"),
    PUBLIC_WS_URL: "ws://localhost/device/v1/ws",
    PUBLIC_DOWNLOAD_BASE: "https://cdn.example.test/apk/",
    ...extraEnv,
  } as NodeJS.ProcessEnv);
  const app = await createApp(cfg);
  await app.listen(0, "127.0.0.1");
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    app,
    baseUrl,
    dbName,
    appDbUrl,
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
      const c = new Client({ connectionString: SUPER });
      await c.connect();
      await c.query(`drop database if exists ${dbName} with (force)`);
      await c.end();
    },
  };
}

/** Inserts a user directly (bootstrap only – everything else goes through the API). */
export async function insertUser(h: Harness, email: string, password: string, opts: { platform?: boolean } = {}) {
  const { db, pool } = createDb({ connectionString: h.appDbUrl });
  try {
    return await withTenant(db, { orgIds: [], platform: true }, async (tx) => {
      const [u] = await tx
        .insert(schema.users)
        .values({ email, name: email, passwordHash: await AuthService.hashPassword(password), isPlatformAdmin: !!opts.platform })
        .returning();
      return u;
    });
  } finally {
    await pool.end();
  }
}

/** Full first-login flow: password → TOTP enrolment → access token. */
export async function loginWithTotpSetup(h: Harness, email: string, password: string): Promise<{ token: string; totpSecret: string }> {
  const r1 = await h.http().post("/v1/auth/login").send({ email, password }).expect(200);
  if (!r1.body.setupRequired) throw new Error(`expected setupRequired, got ${JSON.stringify(r1.body)}`);
  const r2 = await h.http().post("/v1/auth/totp/setup").send({ setupToken: r1.body.setupToken }).expect(200);
  const code = new TOTP({ secret: Secret.fromBase32(r2.body.secret) }).generate();
  const r3 = await h.http().post("/v1/auth/totp/confirm").send({ setupToken: r1.body.setupToken, code }).expect(200);
  return { token: r3.body.accessToken, totpSecret: r2.body.secret };
}

export const totpNow = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret) }).generate();
export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/**
 * Software stand-in for the DPC's Keystore identity. Test-only: on a real box the key lives in
 * Android Keystore and never leaves it.
 */
export class TestDeviceIdentity {
  readonly privateKey: KeyObject;
  readonly publicKeySpki: string;
  deviceId?: string;
  constructor() {
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = kp.privateKey;
    this.publicKeySpki = kp.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  }
  async token(ttlSec = 300) {
    if (!this.deviceId) throw new Error("not enrolled");
    return new SignJWT({}).setProtectedHeader({ alg: "ES256" }).setSubject(this.deviceId).setIssuer(this.deviceId).setAudience("hotel-os").setIssuedAt().setExpirationTime(`${ttlSec}s`).sign(this.privateKey);
  }
  enrollBody(enrollmentToken: string, model = "TestBox 4K") {
    return {
      enrollmentToken,
      publicKey: this.publicKeySpki,
      hardware: { manufacturer: "TestCorp", model, buildFingerprint: "testcorp/box/box:14/UP1A/1:user/release-keys", sdkInt: 34, androidRelease: "14", supportedAbis: ["arm64-v8a"] },
      dpcVersionCode: 1,
      isDeviceOwner: true,
    };
  }
}
