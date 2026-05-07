"""Scrape Consistoire de Paris pages into markdown docs for the vector KB.

Fetches each page, extracts the main content, and writes one .md file
per page into use_cases/consistoire-paris/docs/kb/.

Usage:
    python crawl_kb_consistoire.py
"""

import re
import time
import urllib.request
from pathlib import Path

OUT_DIR = Path(__file__).parent / "use_cases" / "consistoire-paris" / "docs" / "kb"
UA = "Mozilla/5.0 voiceagent-research"

PAGES = [
    ("mariage",               "https://www.consistoire.org/mariage/"),
    ("sav-mariage",           "https://www.consistoire.org/sav-mariage/"),
    ("divorce",               "https://www.consistoire.org/divorce/"),
    ("conversion",            "https://www.consistoire.org/conversion/"),
    ("statut-personnel",      "https://www.consistoire.org/statut-personnel/"),
    ("hevra-kadicha",         "https://www.consistoire.org/hevra-kadicha/"),
    ("naissance",             "https://www.consistoire.org/naissance/"),
    ("cacherout",             "https://www.consistoire.org/la-cacherout/"),
    ("cacherout-info",        "https://www.consistoire.org/informations-importantes/"),
    ("talmud-torah",          "https://www.consistoire.org/le-talmud-torah/"),
    ("jeunesse",              "https://www.consistoire.org/jeunesse/"),
    ("securite",              "https://www.consistoire.org/securite/"),
    ("adresses-utiles",       "https://www.consistoire.org/adresses-utiles/"),
    ("mediation-familiale",   "https://www.consistoire.org/mediation-familiale/"),
    ("handicap",              "https://www.consistoire.org/handicap/"),
    ("chabbat",               "https://www.consistoire.org/chabbat/"),
    ("fetes-et-jeunes",       "https://www.consistoire.org/fetes-et-jeunes/"),
    ("contact",               "https://www.consistoire.org/contact/"),
]

# Footer/nav text to strip from the end
_FOOTER_MARKERS = [
    "17 rue St Georges", "Copyright ©", "Consistoire de Paris\nLe conseil",
    "Plan\nConsistoire",
]

# Tags whose content we keep (main content area)
_KEEP_TAGS = {"p", "h1", "h2", "h3", "h4", "li", "td", "th", "blockquote", "strong", "em"}


def _fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def _html_to_text(html: str) -> str:
    # Remove scripts, styles, nav, footer, header
    for tag in ("script", "style", "nav", "footer", "header", "noscript"):
        html = re.sub(rf"<{tag}[^>]*>.*?</{tag}>", " ", html, flags=re.DOTALL | re.IGNORECASE)

    # Convert headings to markdown
    for level in range(1, 5):
        html = re.sub(
            rf"<h{level}[^>]*>(.*?)</h{level}>",
            lambda m, l=level: f"\n{'#' * l} {re.sub(chr(60) + '[^>]+' + chr(62), '', m.group(1)).strip()}\n",
            html, flags=re.DOTALL | re.IGNORECASE,
        )

    # Convert lists
    html = re.sub(r"<li[^>]*>(.*?)</li>", r"\n- \1", html, flags=re.DOTALL | re.IGNORECASE)

    # Paragraphs and line breaks
    html = re.sub(r"<br\s*/?>", "\n", html, flags=re.IGNORECASE)
    html = re.sub(r"<p[^>]*>", "\n", html, flags=re.IGNORECASE)
    html = re.sub(r"</p>", "\n", html, flags=re.IGNORECASE)

    # Strip all remaining tags
    html = re.sub(r"<[^>]+>", " ", html)

    # Decode entities
    html = (html
        .replace("&rsquo;", "'").replace("&lsquo;", "'")
        .replace("&nbsp;", " ").replace("&amp;", "&")
        .replace("&eacute;", "é").replace("&egrave;", "è")
        .replace("&#038;", "&").replace("&hellip;", "…")
    )

    # Clean whitespace
    text = re.sub(r"[ \t]+", " ", html)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text


def _strip_footer(text: str) -> str:
    for marker in _FOOTER_MARKERS:
        idx = text.find(marker)
        if idx != -1:
            text = text[:idx].strip()
    return text


def scrape(slug: str, url: str) -> str:
    html = _fetch(url)
    text = _html_to_text(html)
    text = _strip_footer(text)

    # Remove very short lines (nav artefacts)
    lines = [l for l in text.splitlines() if len(l.strip()) > 2 or l.strip() == ""]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    return f"# {slug} — {url}\n\nSource: {url}\n\n{text}"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for slug, url in PAGES:
        try:
            content = scrape(slug, url)
            if len(content) < 200:
                print(f"  {slug}: trop court ({len(content)} chars), ignoré")
                continue
            out = OUT_DIR / f"{slug}.md"
            out.write_text(content, encoding="utf-8")
            print(f"  {slug}: {len(content)} chars → {out.name}")
            time.sleep(0.5)
        except Exception as e:
            print(f"  {slug}: ERREUR — {e}")


if __name__ == "__main__":
    print(f"Scraping {len(PAGES)} pages vers {OUT_DIR}…")
    main()
    print("Terminé.")


