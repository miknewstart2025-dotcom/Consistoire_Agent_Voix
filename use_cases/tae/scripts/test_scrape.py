#!/usr/bin/env python3
"""Smoke test: scrape a handful of representative URLs and print results."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrape import fetch_one, parse_one, write_markdown, OUT

URLS = [
    "https://www.tae-paris.org/fr/accueil",
    "https://www.tae-paris.org/fr/competence",
    "https://www.tae-paris.org/fr/cautionnement",
    "https://www.tae-paris.org/fr/casino-vs-ldc-et-gvf-rg-2020017505---jugement-du-18-12-2024---8eme-chambre",
    "https://www.tae-paris.org/fr/le-mot-du-president-1",
    "https://www.tae-paris.org/fr/devenir-juge-consulaire",
    "https://www.tae-paris.org/fr/decisions-remarquables",
    "https://www.tae-paris.org/fr/the-international-chamber",
    "https://www.tae-paris.org/fr/chiffres-cles-du-tribunal-de-commerce-de-paris-160",
]
for u in URLS:
    res = fetch_one(u)
    if not res or res.get("error") or res.get("skipped"):
        print(f"[SKIP] {u}: {res}")
        continue
    rec = parse_one(u, res["html"])
    if rec.get("skipped_reason"):
        print(f"[SKIP] {u}: {rec['skipped_reason']}")
        continue
    p = write_markdown(rec)
    print(f"[OK]   {rec['category']:12s} {len(rec['body']):5d}c  {rec['title'][:60]:60s}  -> {p.relative_to(OUT)}")
