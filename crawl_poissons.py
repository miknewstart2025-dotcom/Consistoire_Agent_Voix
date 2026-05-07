"""Scrape the Consistoire poissons autorisés page into a CSV.

Parses the plain-text fish list (names, aliases, forbidden look-alikes)
from https://www.consistoire.org/poissons-autorises/ and writes a CSV
ready for graph_build.py.

Usage:
    python crawl_poissons.py
    python crawl_poissons.py --out path/to/poissons.csv
"""

import argparse
import csv
import json
import re
import urllib.request
from pathlib import Path

SOURCE = "https://www.consistoire.org/poissons-autorises/"
DEFAULT_OUT = Path(__file__).parent / "use_cases" / "consistoire-paris" / "docs" / "poissons.csv"
UA = "Mozilla/5.0 voiceagent-research"

# Parenthetical patterns:
#   "ou X"            → alias
#   "X interdit(e?)"  → forbidden look-alike
#   anything else     → note
_ALIAS_RE = re.compile(r"\bou\b\s+(.+)", re.IGNORECASE)
_INTERDIT_RE = re.compile(r"([^,]+?)\s+interdit(?:e|s|es)?", re.IGNORECASE)


def _fetch_fish_text() -> str:
    req = urllib.request.Request(SOURCE, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        html = r.read().decode("utf-8")
    # Strip scripts/styles, then all tags
    html = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.DOTALL)
    html = re.sub(r"<style[^>]*>.*?</style>", " ", html, flags=re.DOTALL)
    html = re.sub(r"<[^>]+>", " ", html)
    html = html.replace("&rsquo;", "'").replace("&nbsp;", " ").replace("&amp;", "&")
    text = re.sub(r"\s+", " ", html).strip()
    # Keep only the fish section (Ablette → last fish before footer)
    start = text.find("Ablette")
    end = text.find("rue St Georges", start)  # footer marker
    return text[start:end].strip() if start != -1 else ""


def _parse_entry(raw: str) -> list[dict]:
    """Parse one raw fish token into one authorised entry + possible forbidden entries."""
    # Split name from parenthetical: "Barbue (Turbot interdit)"
    m = re.match(r"^(.+?)\s*\((.+)\)\s*$", raw.strip())
    if m:
        nom_part = m.group(1).strip()
        paren = m.group(2).strip()
    else:
        nom_part = raw.strip()
        paren = ""

    # Resolve aliases in the name part: "Sar Doré ou Sargue" → nom=Sar Doré, alias=[Sargue]
    alias_in_name = _ALIAS_RE.search(nom_part)
    if alias_in_name:
        aliases = [a.strip() for a in alias_in_name.group(1).split(",")]
        nom = nom_part[: alias_in_name.start()].strip()
    else:
        aliases = []
        nom = nom_part

    notes = ""
    forbidden: list[str] = []

    if paren:
        # Collect forbidden look-alikes from parenthetical
        for m2 in _INTERDIT_RE.finditer(paren):
            forbidden.append(m2.group(1).strip().lstrip("(").strip())
        # Collect aliases from parenthetical
        alias_m = _ALIAS_RE.search(paren)
        if alias_m and not forbidden:
            aliases += [a.strip() for a in alias_m.group(1).split(",")]
        elif not forbidden:
            # It's a note (e.g. "Vérifier la présence d'écailles")
            notes = paren

    entries = [{
        "nom": nom,
        "aliases": json.dumps(aliases, ensure_ascii=False) if aliases else "",
        "status": "autorise",
        "notes": notes,
    }]
    for f in forbidden:
        entries.append({
            "nom": f,
            "aliases": "",
            "status": "interdit",
            "notes": f"Ne pas confondre avec {nom}.",
        })
    return entries


def parse(text: str) -> list[dict]:
    # The fish section is a space-separated sequence of capitalized names
    # with optional parentheticals. We split on transitions between entries:
    # a new entry starts with an uppercase letter after a closing paren or
    # after a lowercase word (end of previous name/note).
    # Strategy: split on pattern that separates entries.
    # Each entry ends before a new Title-case word that isn't "ou"/"de"/etc.

    # Tokenize: split text into raw fish tokens.
    # Entries are separated by space, but parentheticals may contain spaces.
    # We detect entry boundaries by looking for Title-Case words that are
    # NOT connectors and NOT inside a parenthetical.
    tokens = []
    current = ""
    depth = 0
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "(":
            depth += 1
            current += ch
        elif ch == ")":
            depth -= 1
            current += ch
        elif ch == " " and depth == 0:
            # Check if next non-space char starts a new entry (uppercase, not connector)
            rest = text[i + 1:].lstrip()
            if rest and rest[0].isupper() and current.strip():
                # Check it's not a continuation word
                next_word = re.match(r"(\w+)", rest)
                if next_word and next_word.group(1).lower() not in (
                    "ou", "de", "du", "des", "le", "la", "les", "et", "en",
                    "rose", "grise", "royale",
                ):
                    tokens.append(current.strip())
                    current = ""
                    i += 1
                    continue
            current += ch
        else:
            current += ch
        i += 1
    if current.strip():
        tokens.append(current.strip())

    rows: list[dict] = []
    for token in tokens:
        token = token.strip()
        if not token or len(token) < 3:
            continue
        rows.extend(_parse_entry(token))
    return rows


def write_csv(rows: list[dict], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["nom", "aliases", "status", "notes"])
        w.writeheader()
        w.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    text = _fetch_fish_text()
    rows = parse(text)
    write_csv(rows, args.out)

    authorises = sum(1 for r in rows if r["status"] == "autorise")
    interdits = sum(1 for r in rows if r["status"] == "interdit")
    print(f"wrote {len(rows)} rows to {args.out}")
    print(f"  autorisés: {authorises}  |  interdits: {interdits}")


if __name__ == "__main__":
    main()
