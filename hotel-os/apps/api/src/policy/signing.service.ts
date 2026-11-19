import { Inject, Injectable, Logger } from "@nestjs/common";
import type { SignedPolicy } from "@hotel-os/protocol";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
import { APP_CONFIG, type AppConfig } from "../config";

/**
 * Signs effective policies with ECDSA P-256 / SHA-256 (DER signature, = Java "SHA256withECDSA").
 * See docs/adr/0004-policy-signing.md. In production the PEM comes from a KMS-backed secret.
 */
@Injectable()
export class SigningService {
  private readonly log = new Logger(SigningService.name);
  private readonly privateKey: KeyObject;
  readonly publicKeySpki: string;
  readonly kid: string;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    if (cfg.POLICY_SIGNING_KEY_PEM) {
      this.privateKey = createPrivateKey(cfg.POLICY_SIGNING_KEY_PEM);
    } else {
      this.log.warn("POLICY_SIGNING_KEY_PEM not set: using an ephemeral key (development only, devices must re-enroll after restart)");
      this.privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    }
    const spki = createPublicKey(this.privateKey).export({ type: "spki", format: "der" });
    this.publicKeySpki = spki.toString("base64");
    this.kid = createHash("sha256").update(spki).digest("hex").slice(0, 16);
  }

  sign(policyJson: string, version: number): SignedPolicy {
    const bytes = Buffer.from(policyJson, "utf8");
    const signature = sign("sha256", bytes, { key: this.privateKey, dsaEncoding: "der" }).toString("base64");
    return { kid: this.kid, alg: "ES256", payload: bytes.toString("base64"), signature, version };
  }

  /** Same verification the device performs. */
  static verify(signed: SignedPolicy, spkiBase64: string): boolean {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
    return verify("sha256", Buffer.from(signed.payload, "base64"), { key, dsaEncoding: "der" }, Buffer.from(signed.signature, "base64"));
  }
}
