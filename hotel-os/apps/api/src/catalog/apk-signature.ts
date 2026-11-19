/**
 * APK Signature Scheme v2 / v3 verification (https://source.android.com/docs/security/features/apksigning/v2).
 * Verifies, for every signer: signature over signed-data with the declared public key, that the first
 * certificate carries that key, and the CHUNKED content digest of the whole APK.
 */
import { constants, createHash, createPublicKey, verify, X509Certificate, type KeyObject } from "node:crypto";
import type { ZipLayout } from "./zip";

const MAGIC = "APK Sig Block 42";
export const V2_ID = 0x7109871a;
export const V3_ID = 0xf05368c0;
const CHUNK = 1024 * 1024;

type Alg = { hash: "sha256" | "sha512"; kind: "rsa-pss" | "rsa-pkcs1" | "ecdsa" | "dsa" };
const ALGS: Record<number, Alg> = {
  0x0101: { hash: "sha256", kind: "rsa-pss" },
  0x0102: { hash: "sha512", kind: "rsa-pss" },
  0x0103: { hash: "sha256", kind: "rsa-pkcs1" },
  0x0104: { hash: "sha512", kind: "rsa-pkcs1" },
  0x0201: { hash: "sha256", kind: "ecdsa" },
  0x0202: { hash: "sha512", kind: "ecdsa" },
  0x0301: { hash: "sha256", kind: "dsa" },
};

export interface SignerInfo {
  certSha256: string;
  subject: string;
  notAfter: string;
}
export interface SignatureResult {
  schemes: number[];
  signers: SignerInfo[];
}

class Reader {
  constructor(private b: Buffer, public p = 0) {}
  get left() { return this.b.length - this.p; }
  u32() { const v = this.b.readUInt32LE(this.p); this.p += 4; return v; }
  lp(): Buffer {
    const n = this.u32();
    if (n > this.left) throw new Error("truncated length-prefixed field");
    const v = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
  seq(): Buffer[] {
    const r = new Reader(this.lp());
    const out: Buffer[] = [];
    while (r.left > 0) out.push(r.lp());
    return out;
  }
}

/** Returns id → value of the APK Signing Block, or null if the APK has none (v1-only). */
export function readSigningBlock(apk: Buffer, z: ZipLayout): { start: number; pairs: Map<number, Buffer> } | null {
  const cd = z.cdOffset;
  if (cd < 32 || apk.toString("latin1", cd - 16, cd) !== MAGIC) return null;
  const sizeFooter = Number(apk.readBigUInt64LE(cd - 24));
  const start = cd - sizeFooter - 8;
  if (start < 0 || Number(apk.readBigUInt64LE(start)) !== sizeFooter) throw new Error("corrupt APK signing block");
  const pairs = new Map<number, Buffer>();
  let p = start + 8;
  while (p < cd - 24) {
    const len = Number(apk.readBigUInt64LE(p));
    if (len < 4 || p + 8 + len > cd - 24) throw new Error("corrupt APK signing block entry");
    pairs.set(apk.readUInt32LE(p + 8), apk.subarray(p + 12, p + 8 + len));
    p += 8 + len;
  }
  return { start, pairs };
}

function contentDigest(apk: Buffer, z: ZipLayout, blockStart: number, hash: "sha256" | "sha512"): Buffer {
  const eocd = Buffer.from(apk.subarray(z.eocdOffset));
  eocd.writeUInt32LE(blockStart, 16); // CD offset as if the signing block were absent
  const sections = [apk.subarray(0, blockStart), apk.subarray(z.cdOffset, z.cdOffset + z.cdSize), eocd];
  const chunkDigests: Buffer[] = [];
  for (const s of sections) {
    for (let o = 0; o < s.length; o += CHUNK) {
      const c = s.subarray(o, Math.min(o + CHUNK, s.length));
      const pre = Buffer.alloc(5);
      pre[0] = 0xa5;
      pre.writeUInt32LE(c.length, 1);
      chunkDigests.push(createHash(hash).update(pre).update(c).digest());
    }
  }
  const top = Buffer.alloc(5);
  top[0] = 0x5a;
  top.writeUInt32LE(chunkDigests.length, 1);
  return createHash(hash).update(top).update(Buffer.concat(chunkDigests)).digest();
}

function verifySig(alg: Alg, key: KeyObject, data: Buffer, sig: Buffer): boolean {
  if (alg.kind === "rsa-pss") return verify(alg.hash, data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: alg.hash === "sha256" ? 32 : 64 }, sig);
  if (alg.kind === "rsa-pkcs1") return verify(alg.hash, data, { key, padding: constants.RSA_PKCS1_PADDING }, sig);
  return verify(alg.hash, data, key, sig); // ECDSA / DSA, DER signatures
}

/** Throws with a precise reason when the APK is not validly signed with v2 or v3. */
export function verifyApkSignature(apk: Buffer, z: ZipLayout): SignatureResult {
  const block = readSigningBlock(apk, z);
  if (!block) throw new Error("APK has no v2/v3 signature (v1-only APKs are refused)");
  const schemes = [V3_ID, V2_ID].filter((id) => block.pairs.has(id));
  if (!schemes.length) throw new Error("APK signing block has no v2/v3 signature");
  const scheme = schemes[0]; // prefer v3, like Android does
  const signersOut: SignerInfo[] = [];
  const digestCache = new Map<string, Buffer>();
  for (const signerBuf of new Reader(block.pairs.get(scheme)!).seq()) {
    const r = new Reader(signerBuf);
    const signedData = r.lp();
    if (scheme === V3_ID) r.p += 8; // minSdk, maxSdk
    const sigs = r.seq().map((s) => {
      const sr = new Reader(s);
      return { alg: sr.u32(), sig: sr.lp() };
    });
    const pub = r.lp();
    const key = createPublicKey({ key: pub, format: "der", type: "spki" });
    const supported = sigs.filter((s) => ALGS[s.alg]);
    if (!supported.length) throw new Error("no supported signature algorithm");
    for (const s of supported) {
      if (!verifySig(ALGS[s.alg], key, signedData, s.sig)) throw new Error("APK signature does not verify (signed data tampered or wrong key)");
    }
    const sd = new Reader(signedData);
    const digests = sd.seq().map((d) => {
      const dr = new Reader(d);
      return { alg: dr.u32(), digest: dr.lp() };
    });
    const certs = sd.seq();
    if (!certs.length) throw new Error("signer has no certificate");
    const cert = new X509Certificate(certs[0]);
    if (!cert.publicKey.export({ type: "spki", format: "der" }).equals(pub)) throw new Error("certificate public key does not match signer key");
    for (const d of digests) {
      const alg = ALGS[d.alg];
      if (!alg) continue;
      const cached = digestCache.get(alg.hash) ?? contentDigest(apk, z, block.start, alg.hash);
      digestCache.set(alg.hash, cached);
      if (!cached.equals(d.digest)) throw new Error("APK content digest mismatch (file modified after signing)");
    }
    signersOut.push({ certSha256: createHash("sha256").update(certs[0]).digest("hex"), subject: cert.subject.replace(/\n/g, ", "), notAfter: cert.validTo });
  }
  return { schemes: schemes.map((s) => (s === V3_ID ? 3 : 2)), signers: signersOut };
}
