"""Refresh the Moïse mikvaot directory from consistoire.org.

Pulls the live dataset at
    https://www.consistoire.org/getJson?f=_mikve
and writes it as a CSV into the Moïse docs folder so the next
`python graph_build.py consistoire-paris --doc mikvaot` picks it up.

Usage:
    python crawl_mikvaot.py             # writes use_cases/consistoire-paris/docs/mikvaot.csv
    python crawl_mikvaot.py --out path  # override output location
"""

import argparse
import csv
import json
import urllib.request
from pathlib import Path

SOURCE = "https://www.consistoire.org/getJson?f=_mikve"
DEFAULT_OUT = Path(__file__).parent / "use_cases" / "consistoire-paris" / "docs" / "mikvaot.csv"
UA = "Mozilla/5.0 voiceagent-research"


def fetch() -> list[dict]:
    req = urllib.request.Request(SOURCE, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _usage(r: dict) -> str:
    parts = []
    if r.get("femme") == "1":
        parts.append("femmes")
    if r.get("homme") == "1":
        parts.append("hommes")
    if r.get("vaisselle") == "1":
        parts.append("vaisselle")
    return ", ".join(parts) if parts else (r.get("type") or "").strip()


def write_csv(rows: list[dict], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
        w.writerow(["nom", "adresse", "code_postal", "ville", "telephone", "contacts", "usage"])
        for r in rows:
            w.writerow([
                (r.get("nom") or "").strip(),
                (r.get("adresse") or "").strip(),
                (r.get("code_postal") or "").strip(),
                (r.get("ville") or "").strip().upper(),
                (r.get("tel") or "").strip(),
                (r.get("detail") or "").strip(),
                _usage(r),
            ])


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh mikvaot CSV from consistoire.org.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    rows = fetch()
    write_csv(rows, args.out)
    print(f"wrote {len(rows)} rows to {args.out}")


if __name__ == "__main__":
    main()
