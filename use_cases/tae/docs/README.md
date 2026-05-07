---
title: "TAE Paris scrape — README"
source: https://www.tae-paris.org/
---

# TAE Paris scrape — README

Knowledge-base snapshot of **www.tae-paris.org** (Tribunal des Activités
Économiques de Paris, formerly Tribunal de commerce de Paris), produced for
indexing by the President's voice assistant.

## Contents

| Path | What it contains |
| --- | --- |
| `index.md` | Human-readable table of contents grouped by category, sorted by title. |
| `manifest.json` | Same TOC as JSON, for programmatic ingestion (one entry per document with `title`, `url`, `slug`, `path`, `keywords`, `size`). |
| `institution/` | Pages institutionnelles : présentation, missions, organisation, présidence, juges consulaires, greffe, auxiliaires de justice, formalités, contact, chambres, contentieux, difficultés des entreprises. |
| `topics/` | Index doctrinaux par mot-clé. Chaque page liste les jugements rangés sous un thème (cautionnement, arbitrage, concurrence déloyale, sociétés, contrats, procédures collectives, etc.). |
| `judgments/` | Décisions individuelles (jugements et ordonnances) avec mots-clés, sommaire et points de droit. |
| `_scrape_report.json` | Run report: total fetched, skipped (404 + empty body), errors. |

## Document format

Every Markdown document carries YAML frontmatter:

```yaml
---
title: "..."
url: https://www.tae-paris.org/fr/<slug>
slug: <slug>
category: institution | topics | judgments
scraped_at: 2026-04-26T20:35:30Z
keywords:
  - "GARANTIES / Cautionnement"
---
```

The body is plain Markdown, suitable for chunking and embedding.

## Re-running the scrape

```bash
cd "$(dirname "$0")/.."
python3 scripts/scrape.py        # fetches sitemap, writes one .md per page
python3 scripts/build_index.py   # regenerates index.md and manifest.json
```

Dependencies: `requests`, `beautifulsoup4`, `markdownify`.

The crawler reads `https://www.tae-paris.org/sitemap.xml`, keeps only French
URLs (`/fr/...`), and is polite (6 concurrent workers, single User-Agent
identifying the bot). The site's `robots.txt` was checked: only admin and
client-area paths are disallowed; all sitemap URLs are crawlable.

## Known gaps

About 30 doctrinal topics exist in the site's taxonomy but have no
judgments tagged under them yet — those pages render "Pas de nouvelles
en ce moment ..." and are captured with that placeholder body. They are
real pages with valid frontmatter; the retriever can choose to ignore
them (filter `body length < 100` or look for the placeholder string).

Nine sitemap entries returned HTTP 404 at scrape time (stale URLs on the
upstream site) and are listed in `_scrape_report.json`.
