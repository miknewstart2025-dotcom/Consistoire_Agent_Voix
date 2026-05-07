"""Refresh the Moïse commerces directory from consistoire.org.

Pulls the live Vue-app dataset at
    https://www.consistoire.org/getJson?f=_commerce
and writes it as a 4-column CSV into the Moïse docs folder so the next
`python kb_build.py consistoire-paris` picks it up.

Usage:
    python crawl_commerces.py             # writes use_cases/consistoire-paris/docs/commerces.csv
    python crawl_commerces.py --out path  # override output location
"""

import argparse
import csv
import json
import re
import urllib.request
from pathlib import Path

SOURCE = "https://www.consistoire.org/getJson?f=_commerce"
DEFAULT_OUT = Path(__file__).parent / "use_cases" / "consistoire-paris" / "docs" / "commerces.csv"
UA = "Mozilla/5.0 voiceagent-research"

# Fallback city per region ID when the API returns ville=null.
# Covers the two edge cases observed (Eden Cook region 14, Le Jardin region 13).
_REGION_FALLBACK: dict[str, tuple[str, str]] = {
    "1":  ("75000", "PARIS"),
    "2":  ("13000", "MARSEILLE"),
    "6":  ("06600", "ANTIBES"),
    "7":  ("06000", "NICE"),
    "8":  ("34000", "MONTPELLIER"),
    "9":  ("54000", "NANCY"),
    "12": ("31000", "TOULOUSE"),
    "13": ("69000", "LYON"),
    "14": ("33000", "BORDEAUX"),
    "15": ("97100", "BASSE-TERRE"),
    "16": ("67000", "STRASBOURG"),
    "17": ("68000", "COLMAR"),
    "18": ("57000", "METZ"),
}

_CP_RE = re.compile(r"\b(\d{4,5})\b")


def _resolve_cp_ville(r: dict) -> tuple[str, str]:
    """Return (code_postal, ville), falling back to region then address parsing."""
    cp = (r.get("code_postal") or "").strip()
    ville = (r.get("ville") or "").strip().upper()

    if cp and ville:
        return cp, ville

    # Try to extract a postal code from the address string.
    adresse = (r.get("adresse") or "")
    m = _CP_RE.search(adresse)
    if m and not cp:
        cp = m.group(1)

    # Use region fallback for missing ville.
    if not ville:
        region_id = str(r.get("id_region") or "")
        fallback = _REGION_FALLBACK.get(region_id)
        if fallback:
            fb_cp, fb_ville = fallback
            cp = cp or fb_cp
            ville = fb_ville

    return cp, ville


def fetch() -> list[dict]:
    req = urllib.request.Request(SOURCE, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def write_csv(rows: list[dict], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
        w.writerow(["nom", "type", "adresse", "code_postal", "ville", "telephone"])
        for r in rows:
            nom = (r.get("nom") or "").strip()
            typ = (r.get("lbl_type") or r.get("type") or "").strip()
            cp, ville = _resolve_cp_ville(r)
            rue = (r.get("adresse") or "").strip()
            tel = (r.get("tel") or "").strip()
            w.writerow([nom, typ, rue, cp, ville, tel])


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh kosher-commerce CSV from consistoire.org.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output CSV path")
    args = parser.parse_args()

    rows = fetch()
    write_csv(rows, args.out)
    print(f"wrote {len(rows)} rows to {args.out}")


if __name__ == "__main__":
    main()
