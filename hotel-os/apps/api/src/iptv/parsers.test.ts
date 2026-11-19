import { describe, expect, it } from "vitest";
import { isPrivate } from "./safe-fetch";
import { parseM3u } from "./m3u";
import { parseXmltv, parseXmltvTime } from "./xmltv";

describe("parseM3u", () => {
  it("parses extended attributes, titles with commas and groups", () => {
    const { entries, skipped } = parseM3u(
      [
        "﻿#EXTM3U x-tvg-url=\"http://epg\"",
        '#EXTINF:-1 tvg-id="tf1.fr" tvg-name="TF1" tvg-logo="http://l/tf1.png" group-title="Généralistes, FR" tvg-chno="1",TF1 HD',
        "http://stream.example/tf1.m3u8",
        '#EXTINF:-1 tvg-id="news",News, Live',
        "#EXTGRP:Info",
        "udp://@239.0.0.1:1234",
        "#EXTINF:-1,Broken entry",
        "not a url",
        "#EXTINF:-1,Dangling",
      ].join("\n"),
    );
    expect(entries).toEqual([
      { name: "TF1 HD", url: "http://stream.example/tf1.m3u8", tvgId: "tf1.fr", tvgName: "TF1", logo: "http://l/tf1.png", group: "Généralistes, FR", language: undefined, channelNumber: 1 },
      { name: "News, Live", url: "udp://@239.0.0.1:1234", tvgId: "news", tvgName: undefined, logo: undefined, group: "Info", language: undefined, channelNumber: undefined },
    ]);
    expect(skipped).toBe(2);
  });

  it("rejects non-playlists", () => {
    expect(() => parseM3u("<html>login</html>")).toThrow(/not an M3U/);
  });
});

describe("XMLTV", () => {
  it("parses times with offsets", () => {
    expect(parseXmltvTime("20261119203000 +0100")?.toISOString()).toBe("2026-11-19T19:30:00.000Z");
    expect(parseXmltvTime("202611192030")?.toISOString()).toBe("2026-11-19T20:30:00.000Z");
    expect(parseXmltvTime("garbage")).toBeNull();
  });

  it("streams programmes, filters window/channels, picks language", () => {
    const xml = `<?xml version="1.0"?><tv>
      <channel id="tf1.fr"><display-name>TF1</display-name></channel>
      <programme start="20261119200000 +0000" stop="20261119210000 +0000" channel="tf1.fr"><title lang="en">News</title><title lang="fr">Journal</title><desc lang="fr">Le 20h &amp; la météo</desc><category>News</category></programme>
      <programme start="20261119210000 +0000" stop="20261119200000 +0000" channel="tf1.fr"><title>Bad times</title></programme>
      <programme start="20261201000000 +0000" stop="20261201010000 +0000" channel="tf1.fr"><title>Too late</title></programme>
      <programme start="20261119200000 +0000" stop="20261119210000 +0000" channel="other"><title>Unwanted</title></programme>
    </tv>`;
    const half = Math.floor(xml.length / 2);
    const r = parseXmltv([xml.slice(0, half), xml.slice(half)], { from: new Date("2026-11-19T00:00:00Z"), to: new Date("2026-11-21T00:00:00Z"), wanted: new Set(["tf1.fr"]), preferredLang: "fr" });
    expect(r.programmes).toEqual([{ channel: "tf1.fr", start: new Date("2026-11-19T20:00:00Z"), stop: new Date("2026-11-19T21:00:00Z"), title: "Journal", description: "Le 20h & la météo", category: "News" }]);
    expect(r.skipped).toBe(1);
    expect(r.channelNames.get("tf1.fr")).toBe("TF1");
  });
});

describe("SSRF guard", () => {
  it("classifies private destinations", () => {
    for (const ip of ["10.1.2.3", "172.20.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "::1", "fd00::1"]) expect(isPrivate(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "151.101.1.1", "2001:4860::8888"]) expect(isPrivate(ip)).toBe(false);
  });
});
