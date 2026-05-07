"""Refresh the Moïse produits directory from consistoire.org.

Pulls the live dataset at
    https://www.consistoire.org/getJson?f=_produits
and writes it as a CSV into the Moïse docs folder so the next
`python graph_build.py consistoire-paris --doc products` picks it up.

Usage:
    python crawl_produits.py             # writes use_cases/consistoire-paris/docs/produits.csv
    python crawl_produits.py --out path  # override output location
"""

import argparse
import csv
import json
import re
import urllib.request
from pathlib import Path

SOURCE = "https://www.consistoire.org/getJson?f=_produits"
DEFAULT_OUT = Path(__file__).parent / "use_cases" / "consistoire-paris" / "docs" / "produits.csv"
UA = "Mozilla/5.0 voiceagent-research"

_TOLERE_RE = re.compile(r"tol[eé]r[eé]", re.IGNORECASE)


def _tags(node: dict) -> list[str]:
    t = []
    if node.get("lait") == "1":
        t.append("L")
    if node.get("bio") == "1":
        t.append("B")
    if node.get("sans_gluten") == "1":
        t.append("SG")
    if node.get("sans_lactose") == "1":
        t.append("SL")
    return t


def _status(node: dict) -> str:
    if node.get("interdit") == "1":
        return "interdit"
    if _TOLERE_RE.search(node.get("remarque") or ""):
        return "tolere"
    return "autorise"


def _split_brand_line(marque_nom: str) -> tuple[str, str | None]:
    """'BLÉDINA : Ma 1ère Blédine' → ('BLÉDINA', 'Ma 1ère Blédine')"""
    if " : " in marque_nom:
        brand, line = marque_nom.split(" : ", 1)
        return brand.strip(), line.strip()
    return marque_nom.strip(), None


def flatten(data: list[dict]) -> list[dict]:
    rows: list[dict] = []

    for top in data:
        top_nom = top["nom"]
        for cat in top.get("categories", []):
            cat_nom = cat["nom"]
            for sc in cat.get("sous_categories", []):
                sc_nom = sc["nom"]
                for prod in sc.get("produit", []):
                    prod_nom = prod["nom"]
                    breadcrumb = f"{top_nom} > {cat_nom} > {sc_nom} > {prod_nom}"
                    for marque in prod.get("marque", []):
                        brand, line = _split_brand_line(marque["nom"])
                        for spe in marque.get("spe", []):
                            # Inherit tags from any level (marque or spe)
                            tags = list(dict.fromkeys(_tags(marque) + _tags(spe)))
                            remarque = (spe.get("remarque") or marque.get("remarque") or "").strip()
                            rows.append({
                                "category": breadcrumb,
                                "brand": brand,
                                "line": line or "",
                                "nom": spe["nom"].strip(),
                                "tags": json.dumps(tags, ensure_ascii=False),
                                "notes": remarque,
                                "status": _status(spe) if spe.get("interdit") or spe.get("remarque") else _status(marque),
                            })
    return rows


def fetch() -> list[dict]:
    req = urllib.request.Request(SOURCE, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def write_csv(rows: list[dict], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["category", "brand", "line", "nom", "tags", "notes", "status"])
        w.writeheader()
        w.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh produits CSV from consistoire.org.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    data = fetch()
    rows = flatten(data)
    write_csv(rows, args.out)
    print(f"wrote {len(rows)} rows to {args.out}")
    by_status = {}
    for r in rows:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    for s, n in sorted(by_status.items()):
        print(f"  {s}: {n}")


if __name__ == "__main__":
    main()
