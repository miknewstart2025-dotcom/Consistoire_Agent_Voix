#!/usr/bin/env python3
"""Retry the URLs reported as empty_body in docs/_scrape_report.json.

Uses a more permissive content extractor than scrape.py:
  - accepts bodies >= 30 chars (vs 60)
  - tries .NewsMasonry, .tab__content, and div.text-resize as fallbacks
  - strips the chrome (header/footer/menu/breadcrumb/cookies) but keeps
    everything else inside .text-resize as the candidate body

Skips URLs whose canonical slug (without trailing -NNN suffix) was already
written by the main crawl (those pages are duplicates).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrape import (  # noqa: E402
    BeautifulSoup,
    OUT,
    Tag,
    categorize,
    clean_soup,
    extract_keywords,
    extract_title,
    fetch_one,
    md,
    session,
    to_markdown,
    write_markdown,
)


def relaxed_get_main(soup: BeautifulSoup) -> Tag | None:
    arts = soup.find_all("article")
    if arts:
        scored = [(len(a.get_text(" ", strip=True)), i, a) for i, a in enumerate(arts)]
        scored.sort(key=lambda t: (-t[0], t[1]))
        if scored[0][0] >= 30:
            return scored[0][2]
    for sel in [".NewsMasonry", ".tab__content", "section.content.content-home", "section.content"]:
        el = soup.select_one(sel)
        if el and len(el.get_text(" ", strip=True)) >= 30:
            return el
    # Last resort: div.text-resize minus chrome
    el = soup.select_one("div.text-resize")
    if el:
        for child in el.select("header, footer, nav, .fil-ariane, .accordion, #consent_wrapper_advanced, #consent_wrapper_about, .consent_preferences, .privacy_prompt, .mm-menu, .mm-panel, .mm-navbar, .social, .socials"):
            child.decompose()
        if len(el.get_text(" ", strip=True)) >= 30:
            return el
    return None


def already_have_canonical(slug: str, existing: set[str]) -> str | None:
    """If `slug` is `foo-bar-NNN` and `foo-bar` is already a written file, return it."""
    canonical = re.sub(r"-\d+$", "", slug)
    if canonical != slug and canonical in existing:
        return canonical
    return None


def main() -> int:
    report = json.loads((OUT / "_scrape_report.json").read_text())
    empties = [s for s in report["skipped"] if s.get("skipped_reason") == "empty_body"]
    print(f"[i] retrying {len(empties)} empty-body URLs", file=sys.stderr)

    existing = {p.stem for p in OUT.rglob("*.md") if p.name not in ("index.md", "README.md")}

    recovered: list[dict] = []
    still_empty: list[dict] = []
    dupes: list[dict] = []
    errors: list[dict] = []

    for s in empties:
        url = s["url"]
        slug = url.rsplit("/", 1)[-1]
        canonical = already_have_canonical(slug, existing)
        if canonical:
            dupes.append({"url": url, "slug": slug, "canonical_slug": canonical})
            continue
        res = fetch_one(url)
        if not res or res.get("error"):
            errors.append({"url": url, "error": (res or {}).get("error", "no response")})
            continue
        if res.get("skipped"):
            errors.append({"url": url, "status": res.get("status")})
            continue
        soup = BeautifulSoup(res["html"], "html.parser")
        clean_soup(soup)
        article = relaxed_get_main(soup)
        title = extract_title(soup, article, slug)
        if not article:
            still_empty.append({"url": url, "slug": slug, "reason": "no_article"})
            continue
        body = to_markdown(article)
        if len(body) < 30:
            still_empty.append({"url": url, "slug": slug, "reason": "body<30"})
            continue
        keywords = extract_keywords(article)
        rec = {
            "url": url,
            "slug": slug,
            "title": title or slug.replace("-", " ").capitalize(),
            "category": categorize(slug, soup),
            "keywords": keywords,
            "body": body,
        }
        path = write_markdown(rec)
        recovered.append({"url": url, "path": str(path.relative_to(OUT))})
        print(f"[ok]  {rec['category']:11s} {len(body):5d}c  {rec['title'][:55]}", file=sys.stderr)

    # Update report
    report.setdefault("retries", []).append({
        "recovered": recovered,
        "still_empty": still_empty,
        "duplicates": dupes,
        "errors": errors,
    })
    (OUT / "_scrape_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(
        f"[done] recovered={len(recovered)} dupes={len(dupes)} "
        f"still_empty={len(still_empty)} errors={len(errors)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
