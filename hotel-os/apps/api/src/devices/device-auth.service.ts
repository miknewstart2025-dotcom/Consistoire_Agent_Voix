import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { type Db, schema, withTenant } from "@hotel-os/db";
import { and, eq, inArray } from "drizzle-orm";
import { decodeJwt, decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { DB } from "../common/db.module";

export interface DevicePrincipal {
  deviceId: string;
  orgId: string;
  hotelId: string;
  roomId: string | null;
}

const MAX_TOKEN_AGE_SEC = 600;
const toPem = (spkiB64: string) => `-----BEGIN PUBLIC KEY-----\n${spkiB64.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`;

/**
 * Devices authenticate with short-lived JWTs (ES256) signed by their Android Keystore key.
 * Claims: iss = sub = deviceId, aud = "hotel-os", iat, exp (≤ 10 min).
 * No shared secret ever leaves the server; revocation is immediate (credential status checked per request).
 */
@Injectable()
export class DeviceAuthService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async authenticate(token: string): Promise<DevicePrincipal> {
    let deviceId: string;
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== "ES256") throw new Error("alg");
      deviceId = decodeJwt(token).sub ?? "";
      if (!/^[0-9a-f-]{36}$/.test(deviceId)) throw new Error("sub");
    } catch {
      throw new UnauthorizedException({ code: "INVALID_DEVICE_TOKEN" });
    }
    const found = await withTenant(this.db, { orgIds: [], platform: true }, async (tx) => {
      const [d] = await tx.select().from(schema.devices).where(and(eq(schema.devices.id, deviceId), inArray(schema.devices.status, ["ENROLLED", "ACTIVE"])));
      if (!d) return null;
      const creds = await tx
        .select()
        .from(schema.deviceCredentials)
        .where(and(eq(schema.deviceCredentials.deviceId, deviceId), eq(schema.deviceCredentials.status, "ACTIVE")));
      return { d, creds };
    });
    if (!found || !found.creds.length) throw new UnauthorizedException({ code: "DEVICE_REVOKED_OR_UNKNOWN" });
    for (const c of found.creds) {
      try {
        const key = await importSPKI(toPem(c.publicKeySpki), "ES256");
        const { payload } = await jwtVerify(token, key, { algorithms: ["ES256"], audience: "hotel-os", subject: deviceId, maxTokenAge: MAX_TOKEN_AGE_SEC, clockTolerance: 120 });
        if (!payload.exp || payload.exp - (payload.iat ?? 0) > MAX_TOKEN_AGE_SEC) throw new Error("ttl too long");
        return { deviceId, orgId: found.d.organizationId, hotelId: found.d.hotelId, roomId: found.d.roomId };
      } catch {
        /* try next credential (rotation overlap) */
      }
    }
    throw new UnauthorizedException({ code: "INVALID_DEVICE_TOKEN" });
  }
}
