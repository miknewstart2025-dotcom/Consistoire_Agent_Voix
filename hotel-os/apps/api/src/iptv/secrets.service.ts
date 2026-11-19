import { Inject, Injectable, Logger } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { APP_CONFIG, type AppConfig } from "../config";

/**
 * Application-level encryption for third-party credentials (IPTV, PMS): AES-256-GCM.
 * Production: SECRETS_KEY comes from a KMS-backed secret; key rotation = re-encrypt job (runbook).
 */
@Injectable()
export class SecretsService {
  private readonly key: Buffer;
  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    if (!cfg.SECRETS_KEY) new Logger(SecretsService.name).warn("SECRETS_KEY not set: deriving from JWT_SECRET (development only)");
    this.key = createHash("sha256").update(cfg.SECRETS_KEY ?? `dev:${cfg.JWT_SECRET}`).digest();
  }
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
  }
  decrypt(token: string): string {
    const [v, iv, tag, data] = token.split(".");
    if (v !== "v1") throw new Error("unknown secret format");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
  }
}
