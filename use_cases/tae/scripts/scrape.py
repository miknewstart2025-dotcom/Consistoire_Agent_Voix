#!/usr/bin/env python3
"""Scrape tae-paris.org French pages and emit one Markdown file per page.

Designed to be re-runnable. Output is written under ../docs/.
Each page becomes docs/<category>/<slug>.md with YAML frontmatter
(title, url, slug, category, scraped_at, keywords) suitable for indexing
into a vector store / retrieval pipeline for a voice assistant.
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup, NavigableString, Tag
from markdownify import markdownify as md

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs"
RAW = ROOT / "raw_html"
SITEMAP = "https://www.tae-paris.org/sitemap.xml"
BASE = "https://www.tae-paris.org"

UA = {"User-Agent": "TAE-Index-Bot/1.0 (voice assistant indexing; contact: [EMAIL_ADDRESS])"}

session = requests.Session()
session.headers.update(UA)


def fetch_sitemap_urls() -> list[str]:
    r = session.get(SITEMAP, timeout=30)
    r.raise_for_status()
    urls = re.findall(r"<loc>([^<]+)</loc>", r.text)
    fr = sorted({u for u in urls if "/fr/" in u or u.rstrip("/") == BASE})
    return fr


# ---- categorization ----------------------------------------------------------

JUDGMENT_RE = re.compile(
    r"(jugement|ordonnance|arret|refere|rg[\- ]?\d|rg[\- ]?j\d|chambre\b)",
    re.I,
)

INSTITUTIONAL_SLUGS = {
    "accueil",
    "competence",
    "competence-d-attribution",
    "competence-internationale",
    "competence-territoriale",
    "la-competence-territoriale",
    "domaines-de-competence-tribunal-de-commerce-de-paris",
    "droit-applicable",
    "clause-type-d-attribution-de-juridiction",
    "chambre-commerciale-internationale",
    "the-international-chamber",
    "chambres-de-contentieux",
    "chiffres-cles-du-tribunal-de-commerce-de-paris",
    "presentation",
    "missions",
    "organisation",
    "le-mot-du-president",
    "le-mot-du-president-1",
    "presidence",
    "vice-presidence",
    "vice-presidents",
    "juges",
    "juges-consulaires",
    "devenir-juge-consulaire",
    "stage-etudiant",
    "temoignages",
    "contact-tribunal-de-commerce-de-paris",
    "actualites",
    "decisions-remarquables",
    "histoire",
    "greffe",
    "greffe-du-tribunal-de-commerce-de-paris",
    "formalites-rcs",
    "responsabilite-de-gestion",
    "mode-amiable-de-resolution-des-differends",
    "conciliation",
    "mediation",
    "mediateurs",
    "conciliateurs-de-justice",
    "mandataires-judiciaires",
    "administrateurs-judiciaires",
    "commissaires-priseurs-judiciaires",
    "huissiers-de-justice",
    "avocats-du-tribunal-de-commerce-de-paris",
    "experts",
    "experts-judiciaires",
    "auxiliaires-de-justice",
    "contribution-pour-la-justice-economique",
    "couts-de-procedure",
    "delais-de-procedure",
    "the-court",
    "competence",
    "difficultes-des-entreprises-presentation",
    "contentieux-commercial-presentation",
    "prevention",
    "mandat-ad-hoc",
    "conciliation-procedure",
    "sauvegarde",
    "redressement-judiciaire",
    "liquidation-judiciaire",
    "traitement-des-difficultes-des-entreprises",
}


def categorize(slug: str, soup: BeautifulSoup) -> str:
    s = slug.lower()
    if JUDGMENT_RE.search(s) or " c/ " in s or "-c--" in s or "-vs-" in s:
        return "judgments"
    if s in INSTITUTIONAL_SLUGS or any(s.startswith(p) for p in (
        "presentation", "mission", "organisation", "competence",
        "presidence", "vice-presid", "le-mot-", "the-",
        "devenir-", "stage-", "temoignage",
        "contact-", "actualites", "decisions-remarquables",
        "histoire", "greffe", "formalites-",
        "mode-amiable", "conciliation", "mediation",
        "mandat-ad-hoc", "sauvegarde", "redressement", "liquidation",
        "auxiliaires", "contribution-pour-",
    )):
        return "institution"
    # Person pages: short slug, no hyphen-heavy patterns, presence of bio
    # Simple heuristic: a slug like "jean-dupont" with 1-3 hyphens may be a person
    parts = s.split("-")
    if 1 <= len(parts) <= 4 and all(len(p) > 1 for p in parts):
        # Will further check via DOM in detect_person
        pass
    # default: doctrinal topic / tag page
    return "topics"


# ---- extraction --------------------------------------------------------------

def clean_soup(soup: BeautifulSoup) -> None:
    for t in soup(["script", "style", "noscript", "iframe"]):
        t.decompose()
    # strip chrome/nav/cookies but NOT .text-resize (it wraps real content)
    for sel in [
        "#consent_wrapper_advanced", "#consent_wrapper_about",
        ".consent_preferences", ".privacy_prompt",
        "#cookie", ".cookie", ".cookies",
        "header", "footer", "nav",
        ".fil-ariane",
        ".mm-menu", ".mm-panel", ".mm-navbar",
        ".accordion",
        ".social", ".socials",
    ]:
        for el in soup.select(sel):
            el.decompose()


def get_main_article(soup: BeautifulSoup) -> Tag | None:
    """Pick the article block with the real page content.

    The site renders multiple <article> tags; pick the largest. For
    tag/index pages (no <article>), fall back to a NewsMasonry list,
    which contains a directory of judgments tagged with the topic.
    """
    arts = soup.find_all("article")
    if arts:
        scored = [(len(a.get_text(" ", strip=True)), i, a) for i, a in enumerate(arts)]
        scored.sort(key=lambda t: (-t[0], t[1]))
        if scored[0][0] >= 80:
            return scored[0][2]
    # Tag pages
    el = soup.select_one(".NewsMasonry, section.content.content-home, section.content")
    return el


def extract_title(soup: BeautifulSoup, article: Tag | None, slug: str = "") -> str:
    # h1 inside article (most reliable)
    if article:
        h1 = article.find("h1")
        if h1:
            return h1.get_text(" ", strip=True)
    if soup.title and soup.title.string:
        t = soup.title.string.strip()
        t = re.sub(r"\s*[-|]\s*(Tribunal des Activités Économiques de Paris|Tribunal de commerce.*)$", "", t)
        if t and "page not found" not in t.lower():
            return t.strip()
    # Tag pages: use slug as title
    if slug:
        return slug.replace("-", " ").capitalize()
    return ""


def extract_keywords(article: Tag | None) -> list[str]:
    if not article:
        return []
    # Pattern: "Mots-clés :" followed by terms separated by line breaks or slashes
    text = article.get_text("\n", strip=True)
    m = re.search(r"Mots[- ]clés\s*[:\-]\s*\n?(.+?)(?=\n(?:Sommaire|Points|$))", text, re.S)
    if not m:
        return []
    block = m.group(1)
    # Each keyword line typically: "DOMAIN / Subdomain"
    lines = [ln.strip() for ln in block.split("\n") if ln.strip()]
    return lines[:20]


def to_markdown(article: Tag) -> str:
    html = str(article)
    out = md(html, heading_style="ATX", bullets="-", strip=["a"])
    # Strip a leading duplicate H1 (we add our own from frontmatter title)
    out = re.sub(r"^\s*#\s+[^\n]+\n+", "", out, count=1)
    # Collapse excessive blank lines
    out = re.sub(r"\n{3,}", "\n\n", out).strip()
    return out


def slugify_path(slug: str) -> str:
    # Sanitize for filesystem
    s = re.sub(r"[^a-z0-9._-]+", "-", slug.lower())
    s = re.sub(r"-+", "-", s).strip("-")
    return s[:140] or "untitled"


def fetch_one(url: str) -> dict | None:
    try:
        r = session.get(url, timeout=30)
    except Exception as e:
        return {"url": url, "error": str(e)}
    if r.status_code != 200:
        return {"url": url, "status": r.status_code, "skipped": True}
    return {"url": url, "html": r.text}


def parse_one(url: str, html: str) -> dict:
    slug = urlparse(url).path.rsplit("/", 1)[-1] or "index"
    soup = BeautifulSoup(html, "html.parser")
    clean_soup(soup)
    article = get_main_article(soup)
    title = extract_title(soup, article, slug)
    keywords = extract_keywords(article) if article else []
    body_md = to_markdown(article) if article else ""

    # Detect 404 sneak (status 200 but page is a generic "not found")
    if title and re.search(r"page not found|introuvable", title, re.I):
        return {"url": url, "slug": slug, "skipped_reason": "page_not_found_body"}
    if not body_md or len(body_md) < 60:
        return {"url": url, "slug": slug, "skipped_reason": "empty_body"}

    category = categorize(slug, soup)
    return {
        "url": url,
        "slug": slug,
        "title": title or slug.replace("-", " ").title(),
        "category": category,
        "keywords": keywords,
        "body": body_md,
    }


def write_markdown(rec: dict) -> Path:
    cat_dir = OUT / rec["category"]
    cat_dir.mkdir(parents=True, exist_ok=True)
    fname = slugify_path(rec["slug"]) + ".md"
    p = cat_dir / fname
    fm_lines = [
        "---",
        f"title: {json.dumps(rec['title'], ensure_ascii=False)}",
        f"url: {rec['url']}",
        f"slug: {rec['slug']}",
        f"category: {rec['category']}",
        f"scraped_at: {dt.datetime.utcnow().isoformat(timespec='seconds')}Z",
    ]
    if rec.get("keywords"):
        fm_lines.append("keywords:")
        for k in rec["keywords"]:
            fm_lines.append(f"  - {json.dumps(k, ensure_ascii=False)}")
    fm_lines.append("---")
    p.write_text("\n".join(fm_lines) + "\n\n# " + rec["title"] + "\n\n" + rec["body"] + "\n", encoding="utf-8")
    return p


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)

    urls = fetch_sitemap_urls()
    print(f"[i] {len(urls)} FR URLs from sitemap", file=sys.stderr)

    written = 0
    skipped: list[dict] = []
    errors: list[dict] = []

    # Concurrent fetch with mild concurrency to be polite
    with ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(fetch_one, u): u for u in urls}
        for i, fut in enumerate(as_completed(futures), 1):
            res = fut.result()
            if res is None:
                continue
            if res.get("error"):
                errors.append(res)
                continue
            if res.get("skipped"):
                skipped.append(res)
                continue
            try:
                rec = parse_one(res["url"], res["html"])
            except Exception as e:
                errors.append({"url": res["url"], "error": f"parse: {e}"})
                continue
            if rec.get("skipped_reason"):
                skipped.append(rec)
                continue
            write_markdown(rec)
            written += 1
            if i % 25 == 0:
                print(f"[i] processed {i}/{len(urls)} (written {written})", file=sys.stderr)

    # Persist run report
    report = {
        "run_at": dt.datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "total": len(urls),
        "written": written,
        "skipped": skipped,
        "errors": errors,
    }
    (OUT / "_scrape_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"[done] written={written} skipped={len(skipped)} errors={len(errors)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
