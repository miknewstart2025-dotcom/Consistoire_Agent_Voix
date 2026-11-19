import { Inject, Injectable, Logger } from "@nestjs/common";
import { type Db, schema, type TenantContext, withTenant } from "@hotel-os/db";
import { and, asc, eq, gt, inArray, lt, notInArray } from "drizzle-orm";
import { DB } from "../common/db.module";
import { APP_CONFIG, type AppConfig } from "../config";
import { parseM3u } from "./m3u";
import { safeFetchText } from "./safe-fetch";
import { SecretsService } from "./secrets.service";
import { parseXmltv } from "./xmltv";

const SYSTEM: TenantContext = { orgIds: [], platform: true };
const MAX_PLAYLIST = 20 * 1024 * 1024;
const MAX_EPG = 200 * 1024 * 1024;
const EPG_PAST_H = 2;
const EPG_FUTURE_D = 7;

export interface SyncResult {
  status: "OK" | "PARTIAL" | "FAILED";
  channels: number;
  removed: number;
  skippedEntries: number;
  programmes: number;
  message?: string;
}

/** Server-side IPTV ingestion: devices receive a compact, normalised lineup + EPG window. */
@Injectable()
export class IptvService {
  private readonly log = new Logger(IptvService.name);
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly secrets: SecretsService,
  ) {}

  async sync(sourceId: string): Promise<SyncResult> {
    const src = await withTenant(this.db, SYSTEM, async (tx) => (await tx.select().from(schema.iptvSources).where(eq(schema.iptvSources.id, sourceId)))[0]);
    if (!src) throw new Error("source not found");
    const auth = src.credentialsEnc ? (JSON.parse(this.secrets.decrypt(src.credentialsEnc)) as { username: string; password: string }) : undefined;
    const fetchOpts = { allowPrivate: this.cfg.IPTV_ALLOW_PRIVATE_SOURCES, timeoutMs: 60_000, auth };
    let result: SyncResult;
    try {
      const { entries, skipped } = parseM3u(await safeFetchText(src.playlistUrl, { ...fetchOpts, maxBytes: MAX_PLAYLIST }));
      if (!entries.length) throw new Error("playlist contains no valid channel");
      const { kept, removed } = await withTenant(this.db, { orgIds: [src.organizationId] }, async (tx) => {
        const existing = await tx.select().from(schema.channels).where(eq(schema.channels.sourceId, src.id));
        const byUrl = new Map(existing.map((c) => [c.streamUrl, c]));
        const used = new Set(existing.map((c) => c.number));
        let next = Math.max(0, ...existing.map((c) => c.number)) + 1;
        const urls = [...new Set(entries.map((e) => e.url))];
        for (const e of entries) {
          const prev = byUrl.get(e.url);
          const values = { name: e.name, epgId: e.tvgId ?? null, logoUrl: e.logo ?? null, category: e.group ?? null, language: e.language ?? null, updatedAt: new Date() };
          if (prev) {
            await tx.update(schema.channels).set(values).where(eq(schema.channels.id, prev.id));
          } else {
            let number = e.channelNumber && !used.has(e.channelNumber) ? e.channelNumber : next;
            while (used.has(number)) number = ++next;
            used.add(number);
            if (number >= next) next = number + 1;
            await tx.insert(schema.channels).values({ ...values, organizationId: src.organizationId, hotelId: src.hotelId, sourceId: src.id, number, streamUrl: e.url });
            byUrl.set(e.url, { id: "", number } as never);
          }
        }
        const del = await tx.delete(schema.channels).where(and(eq(schema.channels.sourceId, src.id), notInArray(schema.channels.streamUrl, urls))).returning({ id: schema.channels.id });
        return { kept: urls.length, removed: del.length };
      });
      result = { status: "OK", channels: kept, removed, skippedEntries: skipped, programmes: 0 };
      if (src.epgUrl) {
        try {
          result.programmes = await this.syncEpg(src.id, src.organizationId, src.epgUrl, fetchOpts);
        } catch (e) {
          result = { ...result, status: "PARTIAL", message: `EPG: ${(e as Error).message}` };
        }
      }
    } catch (e) {
      result = { status: "FAILED", channels: 0, removed: 0, skippedEntries: 0, programmes: 0, message: (e as Error).message };
    }
    await withTenant(this.db, SYSTEM, (tx) =>
      tx.update(schema.iptvSources).set({ lastSyncAt: new Date(), lastSyncStatus: result.status, lastSyncMessage: result.message ?? null }).where(eq(schema.iptvSources.id, src.id)),
    );
    this.log.log(`iptv sync ${src.id}: ${JSON.stringify(result)}`);
    return result;
  }

  private async syncEpg(sourceId: string, orgId: string, url: string, fetchOpts: { allowPrivate: boolean; timeoutMs: number; auth?: { username: string; password: string } }) {
    const xml = await safeFetchText(url, { ...fetchOpts, maxBytes: MAX_EPG });
    const now = Date.now();
    const from = new Date(now - EPG_PAST_H * 3600_000);
    const to = new Date(now + EPG_FUTURE_D * 86400_000);
    return withTenant(this.db, { orgIds: [orgId] }, async (tx) => {
      const wanted = new Set(
        (await tx.select({ epgId: schema.channels.epgId }).from(schema.channels).where(eq(schema.channels.sourceId, sourceId))).map((c) => c.epgId).filter((x): x is string => !!x),
      );
      const { programmes } = parseXmltv([xml], { from, to, wanted });
      await tx.delete(schema.epgPrograms).where(eq(schema.epgPrograms.sourceId, sourceId));
      for (let i = 0; i < programmes.length; i += 1000) {
        await tx.insert(schema.epgPrograms).values(
          programmes.slice(i, i + 1000).map((p) => ({ organizationId: orgId, sourceId, epgId: p.channel, start: p.start, stop: p.stop, title: p.title, description: p.description, category: p.category })),
        );
      }
      return programmes.length;
    });
  }

  async lineup(ctx: TenantContext, hotelId: string, onlyEnabled: boolean) {
    return withTenant(this.db, ctx, (tx) =>
      tx
        .select({ id: schema.channels.id, number: schema.channels.number, name: schema.channels.name, epgId: schema.channels.epgId, logoUrl: schema.channels.logoUrl, category: schema.channels.category, language: schema.channels.language, streamUrl: schema.channels.streamUrl, enabled: schema.channels.enabled })
        .from(schema.channels)
        .where(onlyEnabled ? and(eq(schema.channels.hotelId, hotelId), eq(schema.channels.enabled, true)) : eq(schema.channels.hotelId, hotelId))
        .orderBy(asc(schema.channels.number)),
    );
  }

  async epg(ctx: TenantContext, hotelId: string, from: Date, to: Date) {
    return withTenant(this.db, ctx, async (tx) => {
      const chans = await tx.select({ sourceId: schema.channels.sourceId, epgId: schema.channels.epgId }).from(schema.channels).where(and(eq(schema.channels.hotelId, hotelId), eq(schema.channels.enabled, true)));
      const ids = [...new Set(chans.map((c) => c.epgId).filter((x): x is string => !!x))];
      const sources = [...new Set(chans.map((c) => c.sourceId))];
      if (!ids.length) return [];
      return tx
        .select({ epgId: schema.epgPrograms.epgId, start: schema.epgPrograms.start, stop: schema.epgPrograms.stop, title: schema.epgPrograms.title, description: schema.epgPrograms.description, category: schema.epgPrograms.category })
        .from(schema.epgPrograms)
        .where(and(inArray(schema.epgPrograms.sourceId, sources), inArray(schema.epgPrograms.epgId, ids), gt(schema.epgPrograms.stop, from), lt(schema.epgPrograms.start, to)))
        .orderBy(asc(schema.epgPrograms.epgId), asc(schema.epgPrograms.start));
    });
  }
}
