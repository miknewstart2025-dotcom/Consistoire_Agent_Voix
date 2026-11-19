import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const PRIVATE_V4 = [
  [0x0a000000, 0xff000000], // 10/8
  [0xac100000, 0xfff00000], // 172.16/12
  [0xc0a80000, 0xffff0000], // 192.168/16
  [0x7f000000, 0xff000000], // 127/8
  [0xa9fe0000, 0xffff0000], // 169.254/16 (cloud metadata!)
  [0x64400000, 0xffc00000], // 100.64/10
  [0x00000000, 0xff000000], // 0/8
] as const;

function isPrivate(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
    return PRIVATE_V4.some(([net, mask]) => ((n & mask) >>> 0) === net);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:");
}

/**
 * Fetch for admin-supplied URLs (IPTV playlists, EPG). Prevents SSRF towards the platform's own
 * network: private / loopback / link-local destinations are refused unless explicitly allowed.
 * Size- and time-bounded.
 */
export async function safeFetchText(
  url: string,
  opts: { allowPrivate: boolean; maxBytes: number; timeoutMs: number; auth?: { username: string; password: string } },
): Promise<string> {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error(`unsupported scheme ${u.protocol}`);
  if (!opts.allowPrivate) {
    const addrs = await lookup(u.hostname, { all: true });
    if (addrs.some((a) => isPrivate(a.address))) throw new Error("destination resolves to a private address (blocked)");
  }
  const headers: Record<string, string> = { "user-agent": "HOTEL-OS-ingest/1.0" };
  if (opts.auth) headers.authorization = `Basic ${Buffer.from(`${opts.auth.username}:${opts.auth.password}`).toString("base64")}`;
  const res = await fetch(u, { headers, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > opts.maxBytes) {
      await reader.cancel();
      throw new Error(`response larger than ${opts.maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export { isPrivate };
