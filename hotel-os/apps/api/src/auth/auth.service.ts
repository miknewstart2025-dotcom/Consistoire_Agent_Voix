import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { type Db, schema, withTenant } from "@hotel-os/db";
import { hash, verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { Secret, TOTP } from "otpauth";
import { AuditService } from "../common/audit.service";
import { DB } from "../common/db.module";
import { APP_CONFIG, type AppConfig } from "../config";
import type { MembershipClaim, Principal } from "./principal";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const SYSTEM = { orgIds: [], platform: true };

type TokenKind = "access" | "totp_setup";

@Injectable()
export class AuthService {
  private readonly key: Uint8Array;
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly audit: AuditService,
  ) {
    this.key = new TextEncoder().encode(cfg.JWT_SECRET);
  }

  static hashPassword(pw: string) {
    return hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }

  /** Step 1: password (+ TOTP if enrolled). */
  async login(email: string, password: string, totp: string | undefined, ip?: string) {
    // Auth lookups happen before any tenant is known: trusted system context, narrowly scoped.
    return withTenant(this.db, SYSTEM, async (tx) => {
      const [user] = await tx.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase()));
      const fail = async (reason: string) => {
        if (user) {
          const failed = user.failedLogins + 1;
          await tx
            .update(schema.users)
            .set({
              failedLogins: failed,
              lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil,
            })
            .where(eq(schema.users.id, user.id));
          await this.audit.log(tx, { organizationId: null, actorType: "USER", actorId: user.id, action: "auth.login_failed", data: { reason }, ip });
        }
        return { ok: false as const };
      };
      if (!user) {
        await hash(password); // constant-ish time
        return fail("unknown_user");
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) throw new ForbiddenException({ code: "ACCOUNT_LOCKED" });
      if (!(await verify(user.passwordHash, password))) return fail("bad_password");

      if (user.totpEnabled) {
        if (!totp) return { ok: true as const, totpRequired: true as const };
        if (!this.checkTotp(user.totpSecret!, totp)) return fail("bad_totp");
      } else if (this.cfg.AUTH_REQUIRE_TOTP) {
        await tx.update(schema.users).set({ failedLogins: 0 }).where(eq(schema.users.id, user.id));
        return { ok: true as const, setupRequired: true as const, setupToken: await this.sign(user.id, "totp_setup", 600) };
      }
      await tx.update(schema.users).set({ failedLogins: 0, lockedUntil: null }).where(eq(schema.users.id, user.id));
      await this.audit.log(tx, { organizationId: null, actorType: "USER", actorId: user.id, action: "auth.login", ip });
      return { ok: true as const, accessToken: await this.sign(user.id, "access", this.cfg.JWT_TTL_SEC) };
    }).then((r) => {
      if (!r.ok) throw new UnauthorizedException({ code: "INVALID_CREDENTIALS" });
      return r;
    });
  }

  async beginTotpSetup(setupToken: string) {
    const userId = await this.verify(setupToken, "totp_setup");
    const secret = new Secret({ size: 20 });
    return withTenant(this.db, SYSTEM, async (tx) => {
      const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, userId));
      if (!user || user.totpEnabled) throw new ForbiddenException({ code: "TOTP_ALREADY_ENABLED" });
      await tx.update(schema.users).set({ totpSecret: secret.base32 }).where(eq(schema.users.id, userId));
      const totp = new TOTP({ issuer: "HOTEL OS", label: user.email, secret });
      return { otpauthUrl: totp.toString(), secret: secret.base32 };
    });
  }

  async confirmTotpSetup(setupToken: string, code: string, ip?: string) {
    const userId = await this.verify(setupToken, "totp_setup");
    return withTenant(this.db, SYSTEM, async (tx) => {
      const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, userId));
      if (!user?.totpSecret || user.totpEnabled) throw new ForbiddenException({ code: "TOTP_SETUP_NOT_STARTED" });
      if (!this.checkTotp(user.totpSecret, code)) throw new UnauthorizedException({ code: "INVALID_TOTP" });
      await tx.update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, userId));
      await this.audit.log(tx, { organizationId: null, actorType: "USER", actorId: userId, action: "auth.totp_enabled", ip });
      return { accessToken: await this.sign(userId, "access", this.cfg.JWT_TTL_SEC) };
    });
  }

  /** Resolves an access token to a Principal (memberships re-read from DB on every request: revocation is immediate). */
  async principalFromToken(token: string): Promise<Principal> {
    const userId = await this.verify(token, "access");
    return withTenant(this.db, SYSTEM, async (tx) => {
      const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, userId));
      if (!user) throw new UnauthorizedException();
      const ms = await tx.select().from(schema.memberships).where(eq(schema.memberships.userId, userId));
      const memberships: MembershipClaim[] = ms.map((m) => ({ orgId: m.organizationId, hotelId: m.hotelId, role: m.role }));
      return { userId, email: user.email, isPlatformAdmin: user.isPlatformAdmin, memberships };
    });
  }

  private checkTotp(secret: string, code: string) {
    const totp = new TOTP({ secret: Secret.fromBase32(secret) });
    return totp.validate({ token: code.replace(/\s/g, ""), window: 1 }) !== null;
  }

  private sign(sub: string, kind: TokenKind, ttl: number) {
    return new SignJWT({ kind }).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuedAt().setExpirationTime(`${ttl}s`).setIssuer("hotel-os").sign(this.key);
  }

  private async verify(token: string, kind: TokenKind): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: "hotel-os", algorithms: ["HS256"] });
      if (payload.kind !== kind || !payload.sub) throw new Error("wrong token kind");
      return payload.sub;
    } catch {
      throw new UnauthorizedException({ code: "INVALID_TOKEN" });
    }
  }
}
