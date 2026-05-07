"""Refresh the synagogues/communautés directory from consistoire.org.

Pulls https://www.consistoire.org/getJson?f=_communaute and writes a CSV
for graph_build.py.

Usage:
    python crawl_communautes.py
    python crawl_communautes.py --out path
"""

import argparse
import csv
import json
import re
import urllib.request
from pathlib import Path

SOURCE = "https://www.consistoire.org/getJson?f=_communaute"
DEFAULT_OUT = (
    Path(__file__).parent / "use_cases" / "consistoire-paris" / "docs" / "communautes.csv"
)
UA = "Mozilla/5.0 voiceagent-research"

_OFFICIAL_RE = re.compile(
    r'<span class="fonction">(.*?)\s*:\s*</span>\s*'
    r'<span class="nom-prenom">(.*?)</span>',
    re.IGNORECASE,
)
_EXTRA_TEL_RE = re.compile(r"(?:\+33\s*|0)[1-9][\s.\-]?(?:\d{2}[\s.\-]?){4}")


def _type(r: dict) -> str:
    if r.get("consistoriale") == "1":
        return "consistoriale"
    if r.get("associee") == "1":
        return "associee"
    return "autre"


def _officials(detail: str) -> str:
    """Extract 'Rôle: Prénom NOM' pairs from the detail HTML as a JSON list."""
    pairs = []
    for m in _OFFICIAL_RE.finditer(detail):
        role = m.group(1).strip()
        # Strip any residual HTML tags from the name (e.g. <img> medals)
        name = re.sub(r"<[^>]+>", "", m.group(2)).strip()
        if role and name:
            pairs.append(f"{role}: {name}")
    return json.dumps(pairs, ensure_ascii=False) if pairs else ""


def fetch() -> list[dict]:
    req = urllib.request.Request(SOURCE, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def write_csv(rows: list[dict], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    fields = ["nom", "adresse", "code_postal", "ville", "telephone",
              "email", "site", "type", "officials"]
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow({
                "nom": (r.get("nom") or "").strip(),
                "adresse": (r.get("adresse") or "").strip(),
                "code_postal": (r.get("code_postal") or "").strip(),
                "ville": (r.get("ville") or "").strip().upper(),
                "telephone": (r.get("tel") or "").strip(),
                "email": (r.get("email") or "").strip(),
                "site": (r.get("site") or "").strip(),
                "type": _type(r),
                "officials": _officials(r.get("detail") or ""),
            })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    rows = fetch()
    write_csv(rows, args.out)
    print(f"wrote {len(rows)} rows to {args.out}")
    by_type = {}
    for r in rows:
        t = _type(r)
        by_type[t] = by_type.get(t, 0) + 1
    for t, n in sorted(by_type.items()):
        print(f"  {t}: {n}")


if __name__ == "__main__":
    main()
