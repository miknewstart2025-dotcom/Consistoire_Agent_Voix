"""Build the Consistoire de Paris organigramme from two sources:
  1. /contact/ page  → service, email, téléphone
  2. getJson?f=_consistoire → rôles et personnes nommées (HTML dans 'detail')

Usage:
    python crawl_organigramme.py
    python crawl_organigramme.py --out path/to/organigramme.csv
"""

import argparse
import csv
import json
import re
import urllib.request
from pathlib import Path

CONTACT_URL = "https://www.consistoire.org/contact/"
CONSISTOIRE_URL = "https://www.consistoire.org/getJson?f=_consistoire"
DEFAULT_OUT = (
    Path(__file__).parent
    / "use_cases" / "consistoire-paris" / "docs" / "organigramme.csv"
)
UA = "Mozilla/5.0 voiceagent-research"
SOURCE = "consistoire.org"


def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def _strip_tags(html: str) -> str:
    return re.sub(r"<[^>]+>", " ", html)


# --------------------------------------------------------------------------- #
#  Source 1 : page /contact/ — services avec email + téléphone               #
# --------------------------------------------------------------------------- #

_PHONE_RE = re.compile(r"(?:\+33\s*|0)[1-9][\s.\-]?(?:\d{2}[\s.\-]?){4}")
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")


def _scrape_contact_page() -> list[dict]:
    html = _get(CONTACT_URL)
    text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL)
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{2,}", "\n", text).strip()

    rows = []
    lines = [l.strip() for l in text.splitlines() if l.strip()]

    i = 0
    while i < len(lines):
        line = lines[i]
        # A service entry is a non-phone, non-email line followed by email/phone
        phones = _PHONE_RE.findall(line)
        emails = _EMAIL_RE.findall(line)
        if phones or emails or len(line) < 4:
            i += 1
            continue
        # Check if next few lines contain email/phone
        lookahead = lines[i + 1: i + 6]
        found_email = None
        found_phone = None
        for la in lookahead:
            if not found_email:
                m = _EMAIL_RE.search(la)
                if m:
                    found_email = m.group(0)
            if not found_phone:
                m = _PHONE_RE.search(la)
                if m:
                    found_phone = m.group(0).strip()
        if found_email or found_phone:
            rows.append({
                "service": line,
                "role": "",
                "person": "",
                "telephone": found_phone or "",
                "email": found_email or "",
                "parent_service": "Consistoire de Paris",
            })
        i += 1
    return rows


# --------------------------------------------------------------------------- #
#  Source 2 : _consistoire JSON — rôles et personnes nommées                 #
# --------------------------------------------------------------------------- #

_ROLE_LINE_RE = re.compile(
    r"([^<\n:]+?)\s*:\s*([A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ][^<\n:]{3,})"
)


def _parse_detail_html(html: str, consistoire_name: str) -> list[dict]:
    """Extract role:person pairs from the detail HTML of a consistoire entry."""
    text = _strip_tags(html)
    rows = []
    for m in _ROLE_LINE_RE.finditer(text):
        role = m.group(1).strip().rstrip("s")  # normalize plural
        persons_raw = m.group(2).strip()
        # Multiple persons separated by comma
        for person in persons_raw.split(","):
            person = person.strip()
            if len(person) < 4 or person.startswith("http"):
                continue
            rows.append({
                "service": consistoire_name,
                "role": role,
                "person": person,
                "telephone": "",
                "email": "",
                "parent_service": "",
            })
    return rows


def _scrape_consistoire_json() -> list[dict]:
    data = json.loads(_get(CONSISTOIRE_URL))
    rows = []
    for entry in data:
        name = (entry.get("nom") or "").strip()
        tel = (entry.get("tel") or "").strip()
        email = (entry.get("email") or "").strip()
        detail = (entry.get("detail") or "")

        # Base entry: the consistoire itself
        rows.append({
            "service": name,
            "role": "",
            "person": "",
            "telephone": tel,
            "email": email,
            "parent_service": "",
        })
        # Parse roles from detail HTML
        if detail:
            rows.extend(_parse_detail_html(detail, name))
    return rows


# --------------------------------------------------------------------------- #
#  Merge + write                                                               #
# --------------------------------------------------------------------------- #

def build() -> list[dict]:
    rows: list[dict] = []

    # Contact page: services B2C (Mariages, Divorces, Hevra kadicha, etc.)
    try:
        contact_rows = _scrape_contact_page()
        rows.extend(contact_rows)
        print(f"  /contact/: {len(contact_rows)} services")
    except Exception as e:
        print(f"  /contact/ failed: {e}")

    # JSON: institutional roles
    try:
        json_rows = _scrape_consistoire_json()
        rows.extend(json_rows)
        print(f"  _consistoire JSON: {len(json_rows)} entries")
    except Exception as e:
        print(f"  _consistoire JSON failed: {e}")

    return rows


def write_csv(rows: list[dict], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    fields = ["service", "role", "person", "telephone", "email", "parent_service"]
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    print("Crawling organigramme…")
    rows = build()
    write_csv(rows, args.out)
    print(f"wrote {len(rows)} rows to {args.out}")


if __name__ == "__main__":
    main()
