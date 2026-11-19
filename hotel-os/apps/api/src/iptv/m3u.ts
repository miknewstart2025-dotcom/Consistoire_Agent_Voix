export interface M3uEntry {
  name: string;
  url: string;
  tvgId?: string;
  tvgName?: string;
  logo?: string;
  group?: string;
  language?: string;
  channelNumber?: number;
}

const ATTR = /([a-zA-Z0-9-]+)="([^"]*)"/g;

/**
 * Parses an extended M3U / M3U8 playlist (#EXTM3U, #EXTINF with tvg-* attributes, #EXTGRP).
 * Tolerant: skips malformed entries and reports them.
 */
export function parseM3u(text: string): { entries: M3uEntry[]; skipped: number } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim());
  if (!lines.some((l) => l.startsWith("#EXTM3U") || l.startsWith("#EXTINF"))) {
    throw new Error("not an M3U playlist (missing #EXTM3U / #EXTINF)");
  }
  const entries: M3uEntry[] = [];
  let skipped = 0;
  let pending: Partial<M3uEntry> | null = null;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      if (pending) skipped++;
      const comma = indexOfTitleComma(line);
      const head = comma >= 0 ? line.slice(0, comma) : line;
      const title = comma >= 0 ? line.slice(comma + 1).trim() : "";
      const attrs: Record<string, string> = {};
      for (const m of head.matchAll(ATTR)) attrs[m[1].toLowerCase()] = m[2];
      const chno = Number(attrs["tvg-chno"] ?? attrs["channel-number"]);
      pending = {
        name: title || attrs["tvg-name"] || "",
        tvgId: attrs["tvg-id"] || undefined,
        tvgName: attrs["tvg-name"] || undefined,
        logo: attrs["tvg-logo"] || undefined,
        group: attrs["group-title"] || undefined,
        language: attrs["tvg-language"] || undefined,
        channelNumber: Number.isInteger(chno) && chno > 0 ? chno : undefined,
      };
    } else if (line.startsWith("#EXTGRP:") && pending) {
      pending.group ??= line.slice(8).trim();
    } else if (line.startsWith("#")) {
      continue;
    } else if (pending) {
      if (isStreamUrl(line) && pending.name) entries.push({ ...(pending as M3uEntry), url: line });
      else skipped++;
      pending = null;
    }
  }
  if (pending) skipped++;
  return { entries, skipped };
}

/** The title comma is the first comma outside of quoted attribute values. */
function indexOfTitleComma(line: string): number {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === "," && !inQuotes) return i;
  }
  return -1;
}

const STREAM_SCHEMES = ["http:", "https:", "udp:", "rtp:", "rtsp:", "rtmp:"];
export function isStreamUrl(s: string) {
  try {
    return STREAM_SCHEMES.includes(new URL(s).protocol);
  } catch {
    return false;
  }
}
