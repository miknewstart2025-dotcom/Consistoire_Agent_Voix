import { SaxesParser } from "saxes";

export interface XmltvProgramme {
  channel: string;
  start: Date;
  stop: Date;
  title: string;
  description?: string;
  category?: string;
}

/** XMLTV time: "YYYYMMDDhhmmss +HHMM" (seconds and offset optional, offset defaults to UTC). */
export function parseXmltvTime(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec = "00", off = "+0000"] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec}${off.slice(0, 3)}:${off.slice(3)}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Streaming XMLTV parser: never builds the whole document in memory. Programmes outside
 * [from, to) and for channels not in `wanted` (when given) are dropped while parsing.
 */
export function parseXmltv(
  chunks: Iterable<string>,
  opts: { from: Date; to: Date; wanted?: Set<string>; preferredLang?: string },
): { programmes: XmltvProgramme[]; channelNames: Map<string, string>; skipped: number } {
  const parser = new SaxesParser();
  const programmes: XmltvProgramme[] = [];
  const channelNames = new Map<string, string>();
  let skipped = 0;
  let cur: { channel: string; start: Date | null; stop: Date | null; titles: [string, string][]; desc: [string, string][]; category?: string } | null = null;
  let curChannelId: string | null = null;
  let field: { name: string; lang: string } | null = null;
  let buf = "";

  parser.on("opentag", (tag) => {
    const a = tag.attributes as Record<string, string>;
    if (tag.name === "programme") {
      cur = { channel: a.channel ?? "", start: parseXmltvTime(a.start ?? ""), stop: parseXmltvTime(a.stop ?? ""), titles: [], desc: [] };
    } else if (tag.name === "channel") {
      curChannelId = a.id ?? null;
    } else if ((cur && ["title", "desc", "category"].includes(tag.name)) || (curChannelId && tag.name === "display-name")) {
      field = { name: tag.name, lang: a.lang ?? "" };
      buf = "";
    }
  });
  parser.on("text", (t) => {
    if (field) buf += t;
  });
  parser.on("closetag", (tag) => {
    if (field && tag.name === field.name) {
      const v = buf.trim();
      if (cur && field.name === "title" && v) cur.titles.push([field.lang, v]);
      else if (cur && field.name === "desc" && v) cur.desc.push([field.lang, v]);
      else if (cur && field.name === "category" && v) cur.category ??= v;
      else if (curChannelId && field.name === "display-name" && v && !channelNames.has(curChannelId)) channelNames.set(curChannelId, v);
      field = null;
    } else if (tag.name === "channel") {
      curChannelId = null;
    } else if (tag.name === "programme" && cur) {
      const p = cur;
      cur = null;
      const pick = (xs: [string, string][]) => (xs.find(([l]) => l === opts.preferredLang) ?? xs[0])?.[1];
      const title = pick(p.titles);
      if (!p.channel || !p.start || !p.stop || !title || p.stop <= p.start) {
        skipped++;
        return;
      }
      if (p.stop <= opts.from || p.start >= opts.to) return;
      if (opts.wanted && !opts.wanted.has(p.channel)) return;
      programmes.push({ channel: p.channel, start: p.start, stop: p.stop, title, description: pick(p.desc), category: p.category });
    }
  });
  for (const c of chunks) parser.write(c);
  parser.close();
  return { programmes, channelNames, skipped };
}
