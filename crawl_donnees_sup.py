"""Crawl the 4 supplementary Consistoire datasets:
    - rabbins        (_rabbin)
    - talmud_torah   (_talmud_torah)
    - aumoneries     (_aumonerie)
    - ecoles         (_ecole)

Usage:
    python crawl_donnees_sup.py          # all four
    python crawl_donnees_sup.py rabbins  # one dataset
"""

import argparse
import csv
import json
import re
import urllib.request
from pathlib import Path

DOCS = Path(__file__).parent / "use_cases" / "consistoire-paris" / "docs"
UA = "Mozilla/5.0 voiceagent-research"


def _fetch(endpoint: str) -> list[dict]:
    url = f"https://www.consistoire.org/getJson?f={endpoint}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _strip_tags(html: str) -> str:
    return re.sub(r"<[^>]+>", " ", html).strip()


# --------------------------------------------------------------------------- #
#  Rabbins                                                                    #
# --------------------------------------------------------------------------- #

def crawl_rabbins() -> None:
    rows = _fetch("_rabbin")
    out = DOCS / "rabbins.csv"
    DOCS.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["nom", "prenom", "fonction", "ville", "telephone", "email"])
        w.writeheader()
        for r in rows:
            w.writerow({
                "nom": (r.get("nom") or "").strip(),
                "prenom": (r.get("prenom") or "").strip(),
                "fonction": (r.get("fonction") or "").strip(),
                "ville": (r.get("ville") or "").strip().upper(),
                "telephone": (r.get("tel") or "").strip(),
                "email": (r.get("email") or "").strip(),
            })
    print(f"rabbins: {len(rows)} entrées → {out.name}")


# --------------------------------------------------------------------------- #
#  Talmud Torah                                                               #
# --------------------------------------------------------------------------- #

def crawl_talmud_torah() -> None:
    rows = _fetch("_talmud_torah")
    out = DOCS / "talmud_torah.csv"
    DOCS.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["nom", "adresse", "code_postal", "ville", "telephone", "email", "detail"])
        w.writeheader()
        for r in rows:
            detail = _strip_tags(r.get("detail") or "")
            w.writerow({
                "nom": (r.get("nom") or "").strip(),
                "adresse": (r.get("adresse") or "").strip(),
                "code_postal": (r.get("code_postal") or "").strip(),
                "ville": (r.get("ville") or "").strip().upper(),
                "telephone": (r.get("tel") or "").strip(),
                "email": (r.get("email") or "").strip(),
                "detail": detail,
            })
    print(f"talmud_torah: {len(rows)} entrées → {out.name}")


# --------------------------------------------------------------------------- #
#  Aumôneries                                                                 #
# --------------------------------------------------------------------------- #

def crawl_aumoneries() -> None:
    rows = _fetch("_aumonerie")
    out = DOCS / "aumoneries.csv"
    DOCS.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["nom", "type", "lbl_type", "adresse", "code_postal",
                                          "ville", "telephone", "email", "detail"])
        w.writeheader()
        for r in rows:
            detail = _strip_tags(r.get("detail") or "")
            w.writerow({
                "nom": (r.get("nom") or "").strip(),
                "type": (r.get("type") or "").strip(),
                "lbl_type": (r.get("lbl_type") or "").strip(),
                "adresse": (r.get("adresse") or "").strip(),
                "code_postal": (r.get("code_postal") or "").strip(),
                "ville": (r.get("ville") or "").strip().upper(),
                "telephone": (r.get("tel") or "").strip(),
                "email": (r.get("email") or "").strip(),
                "detail": detail,
            })
    print(f"aumoneries: {len(rows)} entrées → {out.name}")


# --------------------------------------------------------------------------- #
#  Écoles                                                                     #
# --------------------------------------------------------------------------- #

def crawl_ecoles() -> None:
    rows = _fetch("_ecole")
    out = DOCS / "ecoles.csv"
    DOCS.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["nom", "adresse", "code_postal", "ville",
                                          "telephone", "email", "detail"])
        w.writeheader()
        for r in rows:
            detail = _strip_tags(r.get("detail") or "")
            w.writerow({
                "nom": (r.get("nom") or "").strip(),
                "adresse": (r.get("adresse") or "").strip(),
                "code_postal": (r.get("code_postal") or "").strip(),
                "ville": (r.get("ville") or "").strip().upper(),
                "telephone": (r.get("tel") or "").strip(),
                "email": (r.get("email") or "").strip(),
                "detail": detail,
            })
    print(f"ecoles: {len(rows)} entrées → {out.name}")


CRAWLERS = {
    "rabbins": crawl_rabbins,
    "talmud_torah": crawl_talmud_torah,
    "aumoneries": crawl_aumoneries,
    "ecoles": crawl_ecoles,
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", nargs="?", choices=list(CRAWLERS), help="Dataset à crawller (défaut: tous)")
    args = parser.parse_args()
    targets = {args.dataset: CRAWLERS[args.dataset]} if args.dataset else CRAWLERS
    for name, fn in targets.items():
        fn()


if __name__ == "__main__":
    main()
