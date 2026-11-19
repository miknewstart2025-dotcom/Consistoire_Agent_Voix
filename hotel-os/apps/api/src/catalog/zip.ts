import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}
export interface ZipLayout {
  entries: ZipEntry[];
  cdOffset: number;
  cdSize: number;
  eocdOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** Minimal, defensive ZIP reader (APK = ZIP). ZIP64 is refused (never needed for APKs < 4 GB). */
export function readZip(buf: Buffer): ZipLayout {
  if (buf.length < 22) throw new Error("not a ZIP file");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP end of central directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error("ZIP64 not supported");
  if (cdOffset + cdSize > eocd) throw new Error("corrupt central directory");
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error("corrupt central directory entry");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localHeaderOffset: buf.readUInt32LE(p + 42),
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, cdOffset, cdSize, eocdOffset: eocd };
}

/** Extracts one entry with a hard output limit (zip-bomb guard). */
export function extract(buf: Buffer, e: ZipEntry, maxBytes: number): Buffer {
  if (e.size > maxBytes) throw new Error(`${e.name} too large (${e.size} bytes)`);
  const h = e.localHeaderOffset;
  if (buf.readUInt32LE(h) !== LFH_SIG) throw new Error(`bad local header for ${e.name}`);
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
  throw new Error(`unsupported compression method ${e.method} for ${e.name}`);
}
