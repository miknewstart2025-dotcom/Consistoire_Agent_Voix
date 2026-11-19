/**
 * Android binary XML (AXML) reader, enough to read AndroidManifest.xml.
 * Attribute names are resolved via the resource map (android:* attributes may have obfuscated names).
 */
const RES_STRING_POOL = 0x0001;
const RES_XML = 0x0003;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_END_ELEMENT = 0x0103;
const RES_XML_RESOURCE_MAP = 0x0180;

export const ATTR = {
  name: 0x01010003,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  minSdkVersion: 0x0101020c,
  targetSdkVersion: 0x01010270,
  versionCodeMajor: 0x01010576,
  debuggable: 0x0101000f,
  required: 0x0101028e,
} as const;

export type AttrValue = { type: "string"; value: string } | { type: "int"; value: number } | { type: "bool"; value: boolean } | { type: "ref"; value: number } | { type: "other"; value: number };
export interface XmlAttr {
  name: string;
  resId: number;
  value: AttrValue;
}
export interface XmlElement {
  name: string;
  attrs: XmlAttr[];
  children: XmlElement[];
}

function readStringPool(b: Buffer, off: number): string[] {
  const headerSize = b.readUInt16LE(off + 2);
  const count = b.readUInt32LE(off + 8);
  const flags = b.readUInt32LE(off + 16);
  const stringsStart = b.readUInt32LE(off + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = off + stringsStart + b.readUInt32LE(off + headerSize + i * 4);
    if (utf8) {
      // utf16 length (skipped) then utf8 byte length, each 1 or 2 bytes
      p += b[p] & 0x80 ? 2 : 1;
      let len = b[p];
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | b[p + 1];
        p += 2;
      } else p += 1;
      out.push(b.toString("utf8", p, p + len));
    } else {
      let len = b.readUInt16LE(p);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | b.readUInt16LE(p + 2);
        p += 4;
      } else p += 2;
      out.push(b.toString("utf16le", p, p + len * 2));
    }
  }
  return out;
}

export function parseAxml(b: Buffer): XmlElement {
  if (b.length < 8 || b.readUInt16LE(0) !== RES_XML) throw new Error("not a binary Android XML document");
  let strings: string[] = [];
  let resMap: number[] = [];
  const root: XmlElement = { name: "#document", attrs: [], children: [] };
  const stack: XmlElement[] = [root];
  let off = b.readUInt16LE(2);
  const end = Math.min(b.length, b.readUInt32LE(4));
  const str = (i: number) => (i === 0xffffffff ? "" : (strings[i] ?? ""));
  while (off + 8 <= end) {
    const type = b.readUInt16LE(off);
    const headerSize = b.readUInt16LE(off + 2);
    const size = b.readUInt32LE(off + 4);
    if (size < 8 || off + size > end) throw new Error("corrupt AXML chunk");
    if (type === RES_STRING_POOL) strings = readStringPool(b, off);
    else if (type === RES_XML_RESOURCE_MAP) {
      resMap = [];
      for (let p = off + headerSize; p < off + size; p += 4) resMap.push(b.readUInt32LE(p));
    } else if (type === RES_XML_START_ELEMENT) {
      const ext = off + headerSize;
      const name = str(b.readUInt32LE(ext + 4));
      const attrStart = b.readUInt16LE(ext + 8);
      const attrSize = b.readUInt16LE(ext + 10);
      const attrCount = b.readUInt16LE(ext + 12);
      const attrs: XmlAttr[] = [];
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIdx = b.readUInt32LE(a + 4);
        const rawIdx = b.readUInt32LE(a + 8);
        const dataType = b[a + 15];
        const data = b.readUInt32LE(a + 16);
        let value: AttrValue;
        if (dataType === 0x03) value = { type: "string", value: str(data) };
        else if (dataType === 0x10 || dataType === 0x11) value = { type: "int", value: data | 0 };
        else if (dataType === 0x12) value = { type: "bool", value: data !== 0 };
        else if (dataType === 0x01) value = { type: "ref", value: data };
        else value = rawIdx !== 0xffffffff ? { type: "string", value: str(rawIdx) } : { type: "other", value: data };
        attrs.push({ name: str(nameIdx), resId: resMap[nameIdx] ?? 0, value });
      }
      const el: XmlElement = { name, attrs, children: [] };
      stack[stack.length - 1].children.push(el);
      stack.push(el);
    } else if (type === RES_XML_END_ELEMENT) {
      if (stack.length > 1) stack.pop();
    }
    off += size;
  }
  const manifest = root.children[0];
  if (!manifest) throw new Error("empty AXML document");
  return manifest;
}

export function attr(el: XmlElement, key: number | string): AttrValue | undefined {
  return el.attrs.find((a) => (typeof key === "number" ? a.resId === key : a.resId === 0 && a.name === key))?.value;
}
export const attrInt = (el: XmlElement, key: number | string) => {
  const v = attr(el, key);
  return v?.type === "int" ? v.value : v?.type === "string" && /^\d+$/.test(v.value) ? Number(v.value) : undefined;
};
export const attrStr = (el: XmlElement, key: number | string) => {
  const v = attr(el, key);
  return v?.type === "string" ? v.value : undefined;
};
export function* walk(el: XmlElement): Generator<XmlElement> {
  yield el;
  for (const c of el.children) yield* walk(c);
}
