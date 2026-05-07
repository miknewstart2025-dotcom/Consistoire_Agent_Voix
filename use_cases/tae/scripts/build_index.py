#!/usr/bin/env python3
"""Build a master index.md catalog of all scraped TAE pages.

The output is consumed by the voice-assistant indexing pipeline. It also
serves as a human-readable table of contents.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs"


def parse_frontmatter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    block = text[3:end].strip()
    fm: dict = {}
    keywords: list[str] = []
    in_kw = False
    for line in block.splitlines():
        if line.startswith("keywords:"):
            in_kw = True
            continue
        if in_kw:
            m = re.match(r"\s*-\s+(.*)", line)
            if m:
                v = m.group(1).strip()
                if v.startswith('"') and v.endswith('"'):
                    v = json.loads(v)
                keywords.append(v)
                continue
            else:
                in_kw = False
        m = re.match(r"^([a-z_]+):\s*(.*)$", line)
        if m:
            k, v = m.group(1), m.group(2).strip()
            if v.startswith('"') and v.endswith('"'):
                try:
                    v = json.loads(v)
                except Exception:
                    pass
            fm[k] = v
    if keywords:
        fm["keywords"] = keywords
    return fm


def main() -> None:
    files = sorted(OUT.rglob("*.md"))
    files = [f for f in files if f.name != "index.md" and "raw_html" not in f.parts]

    by_cat: dict[str, list[dict]] = defaultdict(list)
    total_chars = 0
    for f in files:
        fm = parse_frontmatter(f)
        if not fm:
            continue
        body_size = f.stat().st_size
        total_chars += body_size
        by_cat[fm.get("category", "unknown")].append({
            "path": str(f.relative_to(OUT)),
            "title": fm.get("title", f.stem),
            "url": fm.get("url", ""),
            "slug": fm.get("slug", f.stem),
            "keywords": fm.get("keywords", []),
            "size": body_size,
        })

    cat_order = ["institution", "topics", "judgments"]
    out_lines: list[str] = []
    out_lines.append("---")
    out_lines.append('title: "TAE Paris — Knowledge Base Index"')
    out_lines.append("source: https://www.tae-paris.org/")
    out_lines.append(f"generated_at: {dt.datetime.now(dt.UTC).isoformat(timespec='seconds')}")
    out_lines.append(f"total_documents: {sum(len(v) for v in by_cat.values())}")
    out_lines.append(f"total_bytes: {total_chars}")
    out_lines.append("---")
    out_lines.append("")
    out_lines.append("# TAE Paris — Knowledge Base Index")
    out_lines.append("")
    out_lines.append(
        "Snapshot of the public website of the **Tribunal des Activités Économiques "
        "de Paris** (formerly Tribunal de commerce de Paris), prepared for indexing "
        "by the President's voice assistant. Each entry below links to a Markdown "
        "document under this directory; the per-document YAML frontmatter carries "
        "`title`, `url`, `slug`, `category`, `keywords` for the retriever."
    )
    out_lines.append("")

    out_lines.append("## Summary")
    out_lines.append("")
    out_lines.append("| Category | Documents | Description |")
    out_lines.append("| --- | ---: | --- |")
    descriptions = {
        "institution": "Pages institutionnelles : présentation du tribunal, missions, organisation, présidence, juges, greffe, auxiliaires de justice, contact.",
        "topics": "Index doctrinaux par mot-clé : chaque page liste les jugements rangés sous un thème (cautionnement, arbitrage, concurrence, …).",
        "judgments": "Décisions individuelles : jugements et ordonnances avec sommaire, mots-clés et points de droit.",
    }
    for cat in cat_order:
        if cat in by_cat:
            out_lines.append(
                f"| {cat} | {len(by_cat[cat])} | {descriptions.get(cat, '')} |"
            )
    out_lines.append("")

    for cat in cat_order:
        if cat not in by_cat:
            continue
        items = sorted(by_cat[cat], key=lambda x: (x["title"] or "").lower())
        out_lines.append(f"## {cat.capitalize()} ({len(items)})")
        out_lines.append("")
        for it in items:
            kws = ""
            if it["keywords"]:
                kws = "  \n  _" + "; ".join(it["keywords"][:5]) + "_"
            out_lines.append(f"- [{it['title']}]({it['path']}) — `{it['slug']}`{kws}")
        out_lines.append("")

    (OUT / "index.md").write_text("\n".join(out_lines), encoding="utf-8")
    print(f"[i] wrote {OUT/'index.md'} ({sum(len(v) for v in by_cat.values())} docs)")

    # Also emit a JSON manifest for programmatic ingestion
    manifest = {
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "source": "https://www.tae-paris.org/",
        "categories": {cat: by_cat.get(cat, []) for cat in cat_order},
    }
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[i] wrote {OUT/'manifest.json'}")


if __name__ == "__main__":
    main()
