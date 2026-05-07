"""Build the per-use-case fact graph (SQLite).

Usage:
    python graph_build.py <slug>                # build all known collections
    python graph_build.py <slug> --doc mikvaot  # single collection

Currently only `consistoire-paris` has configured extractors. Add a
new collection by writing a small extractor function and registering
it in EXTRACTORS below.

CSV collections load directly; PDF collections are sent to Claude as
native PDF document blocks (much cleaner than post-processing
multi-column pdfplumber output) and parsed as structured JSON.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(".env.local")

from graph import connect, db_path, normalize_name  # noqa: E402
from kb import docs_dir  # noqa: E402

# Cheap, fast, and structured-JSON is well within its capabilities.
EXTRACTION_MODEL = "claude-haiku-4-5-20251001"


# --------------------------------------------------------------------------- #
#  Shared helpers                                                             #
# --------------------------------------------------------------------------- #

_CP_RE = re.compile(r"\b(\d{5})\b")
_PARIS_NE_RE = re.compile(r"\bParis\s+(\d{1,2})\s*e?r?\b", re.IGNORECASE)


def _split_cp_ville(adresse: str) -> tuple[str | None, str | None]:
    """Pull '75016 PARIS' out of a free-form French postal address."""
    m = _CP_RE.search(adresse)
    if not m:
        return None, None
    cp = m.group(1)
    tail = adresse[m.end():].strip(" ,-")
    ville = tail.split(",")[0].strip() or None
    return cp, ville


def _cp_from_ville(ville: str | None) -> str | None:
    """'Paris 16e' -> '75016'. Covers the Mikvaot PDF where the arrondissement
    is given as a column header, not embedded in the street address."""
    if not ville:
        return None
    m = _PARIS_NE_RE.search(ville)
    if not m:
        return None
    n = int(m.group(1))
    return f"750{n:02d}" if 1 <= n <= 20 else None


def _sha1(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as f:
        for blob in iter(lambda: f.read(65536), b""):
            h.update(blob)
    return h.hexdigest()[:16]


def _record_source(conn: sqlite3.Connection, filename: str, sha1: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO sources (filename, sha1, built_at) VALUES (?, ?, ?)",
        (filename, sha1, datetime.now(timezone.utc).isoformat(timespec="seconds")),
    )


# --------------------------------------------------------------------------- #
#  commerces.csv → commerces                                                  #
# --------------------------------------------------------------------------- #

def extract_commerces(slug: str, conn: sqlite3.Connection) -> int:
    path = docs_dir(slug) / "commerces.csv"
    if not path.exists():
        print(f"[{slug}] commerces.csv not found, skipping")
        return 0

    conn.execute("DELETE FROM commerces WHERE source = ?", (path.name,))
    n = 0
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader, start=2):  # header is line 1
            nom = (row.get("nom") or "").strip()
            typ = (row.get("type") or "").strip()
            adresse = (row.get("adresse") or "").strip()
            tel = (row.get("telephone") or "").strip() or None
            if not (nom and adresse):
                continue
            # Use explicit columns when present (new CSV format), fallback to parsing.
            cp = (row.get("code_postal") or "").strip() or None
            ville = (row.get("ville") or "").strip().upper() or None
            if not cp or not ville:
                cp2, ville2 = _split_cp_ville(adresse)
                cp = cp or cp2
                ville = ville or ville2
            conn.execute(
                """INSERT INTO commerces
                   (nom, type, adresse, code_postal, ville, telephone, source, locator)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (nom, typ, adresse, cp, ville, tel, path.name, f"row {i}"),
            )
            n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


# --------------------------------------------------------------------------- #
#  Mikvaot5785.pdf → mikvaot (via Claude PDF extraction)                      #
# --------------------------------------------------------------------------- #

MIKVAOT_PROMPT = """Extract every mikvé listed in this document as a JSON array.

Each entry must have:
- "nom": name of the mikvé or institution, or null if none.
- "adresse": full street address as a single line.
- "code_postal": 5-digit French postal code. REQUIRED for every entry.
  - If a postal code is written in the address, use it.
  - Otherwise, infer it from the arrondissement / department header the entry sits under:
      "9e ARRONDISSEMENT"  -> "75009"
      "16e ARRONDISSEMENT" -> "75016"
      "20e ARRONDISSEMENT" -> "75020"
      "SEINE SAINT DENIS (93)" -> use the commune's postal code if known; else "93000"
      "VAL DE MARNE (94)" -> commune postal code if known; else "94000"
  - Never leave this null for a Paris entry.
- "ville": commune name. For Paris arrondissements use "Paris 9e", "Paris 16e", etc.
- "telephone": main phone number of the mikvé itself (not the contact person), else null.
- "contacts": free-form string listing all contact persons with their roles and phone numbers, e.g. "Femmes : Mme X : 06...; Hommes : M. Y : 01...". Null if none.
- "usage": one of "femmes", "hommes", "vaisselle", or a comma-separated combination (e.g. "femmes, vaisselle"). Null if unclear.
- "notes": any additional notes (schedule, appointment-only, métro, etc.), else null.
- "locator": an approximate page reference such as "p.1" or "p.2".

Return ONLY the JSON array. No prose, no code fences. The document
is a tri-column leaflet in French — entries can span columns; the
arrondissement / department header applies to every entry beneath it
until the next header."""


def _pdf_document_block(path: Path) -> dict:
    data = base64.standard_b64encode(path.read_bytes()).decode("ascii")
    return {
        "type": "document",
        "source": {"type": "base64", "media_type": "application/pdf", "data": data},
    }


def _pdf_page_document_block(path: Path, page_num: int) -> dict:
    """Isolate a single 1-indexed page of a PDF as its own document block.

    Used for extractions where asking Claude to 'focus on page N of the
    full PDF' risks cross-page contamination (e.g. the products catalog,
    where one brand's variants span several pages).
    """
    from io import BytesIO
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(str(path))
    writer = PdfWriter()
    writer.add_page(reader.pages[page_num - 1])
    buf = BytesIO()
    writer.write(buf)
    data = base64.standard_b64encode(buf.getvalue()).decode("ascii")
    return {
        "type": "document",
        "source": {"type": "base64", "media_type": "application/pdf", "data": data},
    }


def _extract_json_array(text: str) -> list[dict]:
    text = text.strip()
    # Strip fenced code blocks if Claude slips one in.
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def extract_mikvaot(slug: str, conn: sqlite3.Connection) -> int:
    import anthropic

    path = docs_dir(slug) / "Mikvaot5785.pdf"
    if not path.exists():
        print(f"[{slug}] Mikvaot5785.pdf not found, skipping")
        return 0

    client = anthropic.Anthropic()
    print(f"[{slug}] extracting {path.name} via {EXTRACTION_MODEL}…")
    resp = client.messages.create(
        model=EXTRACTION_MODEL,
        max_tokens=8192,
        messages=[{
            "role": "user",
            "content": [_pdf_document_block(path), {"type": "text", "text": MIKVAOT_PROMPT}],
        }],
    )
    raw = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
    entries = _extract_json_array(raw)

    conn.execute("DELETE FROM mikvaot WHERE source = ?", (path.name,))
    n = 0
    for e in entries:
        adresse = (e.get("adresse") or "").strip()
        if not adresse:
            continue
        cp = (e.get("code_postal") or None)
        ville = (e.get("ville") or None)
        if not cp or not ville:
            cp2, ville2 = _split_cp_ville(adresse)
            cp = cp or cp2
            ville = ville or ville2
        cp = cp or _cp_from_ville(ville)
        conn.execute(
            """INSERT INTO mikvaot
               (nom, adresse, code_postal, ville, telephone, contacts, usage, notes, source, locator)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                e.get("nom"),
                adresse,
                cp,
                ville,
                e.get("telephone"),
                e.get("contacts"),
                e.get("usage"),
                e.get("notes"),
                path.name,
                e.get("locator") or "",
            ),
        )
        n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


# --------------------------------------------------------------------------- #
#  Mariages_interdits_5786_5790.pdf → marriage_forbidden_periods              #
# --------------------------------------------------------------------------- #

MARRIAGES_PROMPT = """Extract every forbidden-marriage period listed in this
document as a JSON array. The document lists year-by-year calendars in
Hebrew years 5786..5790.

Emit one entry per forbidden period. DO NOT emit a catch-all entry for
"Tous les chabbatot" — that rule is handled separately.

Each entry must have:
- "hebrew_year": the year header, e.g. "5786".
- "start_date": first forbidden day, ISO YYYY-MM-DD.
- "end_date":   last forbidden day, ISO YYYY-MM-DD, INCLUSIVE. For single-day
  events (e.g. "Mardi 30 décembre 2025 (Jeûne 10 Tevet)"), start == end.
- "reason":     short label extracted from the parenthetical, e.g.
  "Roch Hachana", "Jeûne de Guedalia", "Kippour", "Soukot", "Jeûne 10 Tevet",
  "Jeûne d'Esther", "Pessah", "Omer", "Chavouot", "3 semaines", "Veille de Kippour".
- "rite":       "sefarade" or "achkenaze" for Omer periods; null for all others.
- "exceptions": JSON array of ISO dates excluded from the range (e.g. Lag
  Baomer for Achkénaze Omer). null if none.
- "locator":    page reference like "p.1".

For each year's OMER section you must emit TWO entries:
  { reason: "Omer", rite: "sefarade", ... }
  { reason: "Omer", rite: "achkenaze", exceptions: ["<Lag Baomer ISO date>"], ... }

Return ONLY the JSON array. No prose, no code fences."""


def extract_marriages(slug: str, conn: sqlite3.Connection) -> int:
    import anthropic

    path = docs_dir(slug) / "Mariages_interdits_5786_5790.pdf"
    if not path.exists():
        print(f"[{slug}] Mariages_interdits_5786_5790.pdf not found, skipping")
        return 0

    client = anthropic.Anthropic()
    print(f"[{slug}] extracting {path.name} via {EXTRACTION_MODEL}…")
    resp = client.messages.create(
        model=EXTRACTION_MODEL,
        max_tokens=8192,
        messages=[{
            "role": "user",
            "content": [_pdf_document_block(path), {"type": "text", "text": MARRIAGES_PROMPT}],
        }],
    )
    raw = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
    entries = _extract_json_array(raw)

    conn.execute("DELETE FROM marriage_forbidden_periods WHERE source = ?", (path.name,))
    n = 0
    for e in entries:
        start = (e.get("start_date") or "").strip()
        end = (e.get("end_date") or "").strip()
        reason = (e.get("reason") or "").strip()
        if not (start and end and reason):
            continue
        exceptions = e.get("exceptions")
        exceptions_json = json.dumps(exceptions) if exceptions else None
        conn.execute(
            """INSERT INTO marriage_forbidden_periods
               (hebrew_year, start_date, end_date, reason, rite, exceptions, source, locator)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                (e.get("hebrew_year") or "").strip(),
                start,
                end,
                reason,
                (e.get("rite") or None),
                exceptions_json,
                path.name,
                e.get("locator") or "",
            ),
        )
        n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


# --------------------------------------------------------------------------- #
#  Poissons_Autorises_avec_photos5785.pdf → fish_species                      #
# --------------------------------------------------------------------------- #

FISH_PROMPT = """Extract every fish species from this document as a JSON array.

The document is the Consistoire de Paris's list of kosher-authorized fish,
printed as a grid of photos and French names. Alongside some entries
are parenthetical exceptions like "(Turbot interdit)" or "(Saumonette
interdite)" — those are explicitly forbidden look-alikes that must be
captured as their own entries with status "interdit".

Each authorized entry appears either as a single name ("Sardine") or
as two interchangeable names joined by "ou" ("Sar doré ou Sargue",
"Mulet ou Muge", "Cabillaud ou Cabilleau"). When there is an "ou",
emit a SINGLE entry using the first name as canonical and the second
as an alias.

Emit one JSON entry per fish:
- "nom":     canonical French name (first name when there are alternates).
- "aliases": array of alternate French spellings / names. Empty array if none.
- "status":  "autorise" for the main listed fish, "interdit" for the
             parenthetical exceptions.
- "notes":   short context for the voice agent (e.g. "Ne pas confondre
             avec la Barbue."). null if no useful context.
- "locator": page reference like "p.1" or "p.2".

Return ONLY the JSON array. No prose, no code fences."""


def extract_fish(slug: str, conn: sqlite3.Connection) -> int:
    import anthropic

    path = docs_dir(slug) / "Poissons_Autorises_avec_photos5785.pdf"
    if not path.exists():
        print(f"[{slug}] {path.name} not found, skipping")
        return 0

    client = anthropic.Anthropic()
    print(f"[{slug}] extracting {path.name} via {EXTRACTION_MODEL}…")
    resp = client.messages.create(
        model=EXTRACTION_MODEL,
        max_tokens=8192,
        messages=[{
            "role": "user",
            "content": [_pdf_document_block(path), {"type": "text", "text": FISH_PROMPT}],
        }],
    )
    raw = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
    entries = _extract_json_array(raw)

    conn.execute("DELETE FROM fish_species WHERE source = ?", (path.name,))
    n = 0
    for e in entries:
        nom = (e.get("nom") or "").strip()
        status = (e.get("status") or "").strip()
        if not nom or status not in ("autorise", "interdit"):
            continue
        aliases = [a.strip() for a in (e.get("aliases") or []) if a and a.strip()]
        aliases_norm = [normalize_name(a) for a in aliases]
        conn.execute(
            """INSERT INTO fish_species
               (nom, nom_normalized, aliases, aliases_normalized, status, notes, source, locator)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                nom,
                normalize_name(nom),
                json.dumps(aliases, ensure_ascii=False) if aliases else None,
                json.dumps(aliases_norm) if aliases_norm else None,
                status,
                e.get("notes"),
                path.name,
                e.get("locator") or "",
            ),
        )
        n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


# --------------------------------------------------------------------------- #
#  Registry + CLI                                                             #
# --------------------------------------------------------------------------- #

MOHALIM_PROMPT = """Extract every mohel listed in this document as a JSON array.

Each entry must have:
- "civilite": 'M.' or 'Mme' (as written).
- "prenom":   given name(s), e.g. "Jacques", "Gérard Yoël".
- "nom":      family name, preserved as written (typically uppercase).
- "telephone": phone number as printed.
- "regions":  JSON array of canonical region tags. Rules:
              - No parenthetical region  -> ["IDF"]    (the Paris-based AFM default)
              - "(Région PACA)"          -> ["PACA"]
              - "(Région Bas-Rhin)"      -> ["Bas-Rhin"]
              - "(Région Aquitaine)"     -> ["Aquitaine"]
              - "(Région Rhône Alpes)"   -> ["Rhône-Alpes"]
              - "(Régions IDF et PACA)"  -> ["IDF", "PACA"]
              Preserve the same canonical tags for any similar patterns.
- "locator":  page reference, e.g. "p.1".

Return ONLY the JSON array. No prose, no code fences."""


def extract_mohalim(slug: str, conn: sqlite3.Connection) -> int:
    import anthropic

    path = docs_dir(slug) / "AFM_Mohalim0924.pdf"
    if not path.exists():
        print(f"[{slug}] {path.name} not found, skipping")
        return 0

    client = anthropic.Anthropic()
    print(f"[{slug}] extracting {path.name} via {EXTRACTION_MODEL}…")
    resp = client.messages.create(
        model=EXTRACTION_MODEL,
        max_tokens=4096,
        messages=[{
            "role": "user",
            "content": [_pdf_document_block(path), {"type": "text", "text": MOHALIM_PROMPT}],
        }],
    )
    raw = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
    entries = _extract_json_array(raw)

    conn.execute("DELETE FROM mohalim WHERE source = ?", (path.name,))
    n = 0
    for e in entries:
        prenom = (e.get("prenom") or "").strip()
        nom = (e.get("nom") or "").strip()
        tel = (e.get("telephone") or "").strip()
        if not (prenom and nom and tel):
            continue
        regions = e.get("regions") or ["IDF"]
        conn.execute(
            """INSERT INTO mohalim
               (civilite, prenom, nom, nom_normalized, telephone, regions, source, locator)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                (e.get("civilite") or "").strip() or None,
                prenom,
                nom,
                normalize_name(nom),
                tel,
                json.dumps(regions, ensure_ascii=False),
                path.name,
                e.get("locator") or "",
            ),
        )
        n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


# --------------------------------------------------------------------------- #
#  Consistoire-Produits2025-2026.pdf → products (38 pages, per-page loop)     #
# --------------------------------------------------------------------------- #

# Per-page prompt. Pages 1-2 are preamble (cacherout overview + additive
# rules) and are skipped. Pages 3..38 are the actual catalog — multi-column
# tables grouped under CATEGORY banners with subcategory subheadings.
#
# This prompt is used with a SINGLE-PAGE sub-PDF (see _pdf_page_document_block);
# isolating the page avoids Claude confusing products across pages, which
# happened badly with the full-PDF approach (whole brands got misattributed).
PRODUCTS_PAGE_PROMPT = """Extract every kosher-selected product in this
(single-page) document as a JSON array. The source page number is p.{page}.

IMPORTANT: this catalog is dense; a single page typically contains dozens to
150+ distinct entries across many brands. Enumerate EVERY named variant —
when a brand lists comma-separated flavors ("Cassis, Citron, Fraise..."),
emit one entry per flavor. Do not summarize.

Each entry must have:
- "category":  breadcrumb of headings the product sits under, separated by " > ".
               Include the all-caps top-level category (e.g. "BÉBÉ", "BOISSONS",
               "FROMAGES") and every subheading down to the product (e.g.
               "BÉBÉ > ALIMENTATION INFANTILE > Céréales > Céréales 4 mois+").
- "brand":     brand name as printed, typically all-caps (e.g. "BLÉDINA",
               "MODILAC EXPERT", "NESTLÉ").
- "line":      product line when the catalog groups variants under a named
               line (e.g. "MA 1ÈRE BLÉDINE", "BLÉDINE"); null otherwise.
- "nom":       the specific product / variant (e.g. "Blédilait 1 : en mini-biberon",
               "Nature sans gluten", "Bio 2").
- "tags":      array of letter codes printed before the product. Use only
               these values: "L" (laitier), "B" (bio), "SG" (sans gluten),
               "SL" (sans lactose), "N" (non-laitier / parvé). Empty array
               if no code is printed.
- "notes":     any explicit condition or warning attached to the entry
               ("Sur indication médicale", "Toléré jusqu'à 1 an", "Contrôler
               l'absence de ..."), else null.
- "status":    "autorise" by default; "tolere" for items explicitly described
               as "Toléré ..."; "interdit" ONLY for items explicitly called
               out as interdits (e.g. "Turbot interdit", "Les laits contenant
               ... sont interdits"). Generic reminders of forbidden additives
               from the preamble DO NOT count.
- "locator":   "p.{page}".

Rules:
- Do NOT invent products. If the page only has a category banner and no items, return [].
- Preserve accents and casing of brand and product names.
- When a product is a family listed as "TOUTES MARQUES tolérées ...", emit a
  single entry with brand="TOUTES MARQUES", status="tolere", and the condition
  in "notes".

Return ONLY the JSON array. No prose, no code fences."""


def _extract_products_page(
    client, path: Path, page_num: int,
) -> list[dict]:
    """Extract products from a single page by sending a one-page sub-PDF.

    Uses streaming because dense pages can emit 30k+ chars of JSON
    (well past the 10-minute nonstream timeout threshold), and a
    max_tokens hit truncates mid-object — the parser then silently
    returns [] and the whole page is lost.
    """
    import anthropic  # noqa: F401  (already imported by caller)
    page_block = _pdf_page_document_block(path, page_num)
    prompt = PRODUCTS_PAGE_PROMPT.format(page=page_num)
    chunks: list[str] = []
    with client.messages.stream(
        model=EXTRACTION_MODEL,
        max_tokens=32000,
        messages=[{
            "role": "user",
            "content": [page_block, {"type": "text", "text": prompt}],
        }],
    ) as stream:
        for t in stream.text_stream:
            chunks.append(t)
        final = stream.get_final_message()
    raw = "".join(chunks)
    if final.stop_reason == "max_tokens":
        print(f"  p.{page_num}: WARNING hit max_tokens — JSON likely truncated")
    try:
        return _extract_json_array(raw)
    except json.JSONDecodeError:
        return []


def _insert_product(conn: sqlite3.Connection, path: Path, page_num: int, e: dict) -> bool:
    brand = (e.get("brand") or "").strip()
    nom = (e.get("nom") or "").strip()
    category = (e.get("category") or "").strip()
    status = (e.get("status") or "autorise").strip()
    if not (brand and nom and category):
        return False
    if status not in ("autorise", "tolere", "interdit"):
        status = "autorise"
    tags = [t.strip() for t in (e.get("tags") or []) if t and t.strip()]
    conn.execute(
        """INSERT INTO products
           (category, brand, brand_normalized, line, nom, nom_normalized,
            tags, notes, status, source, locator)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            category,
            brand,
            normalize_name(brand),
            (e.get("line") or None),
            nom,
            normalize_name(nom),
            json.dumps(tags, ensure_ascii=False) if tags else None,
            (e.get("notes") or None),
            status,
            path.name,
            e.get("locator") or f"p.{page_num}",
        ),
    )
    return True


def extract_products(slug: str, conn: sqlite3.Connection) -> int:
    """Per-page extraction using single-page sub-PDFs.

    Each page is split out via pypdf and sent as its own document block,
    which is what prevents cross-page contamination (observed with
    full-PDF + "focus on page N" prompting — whole brands got
    misattributed).
    """
    import anthropic
    import pdfplumber

    path = docs_dir(slug) / "Consistoire-Produits2025-2026.pdf"
    if not path.exists():
        print(f"[{slug}] {path.name} not found, skipping")
        return 0

    with pdfplumber.open(path) as pdf:
        num_pages = len(pdf.pages)
    print(f"[{slug}] extracting {path.name} via {EXTRACTION_MODEL} ({num_pages} pages)")

    client = anthropic.Anthropic()
    conn.execute("DELETE FROM products WHERE source = ?", (path.name,))
    n_total = 0

    # Pages 1-2 are preamble/rules. Pages 37-38 are a placeholder page
    # for the separate fish list (no product entries here — already
    # covered by the fish extractor).
    for page_num in range(3, num_pages + 1):
        try:
            entries = _extract_products_page(client, path, page_num)
        except Exception as exc:
            print(f"  p.{page_num}: API error — {exc}")
            continue

        page_count = sum(_insert_product(conn, path, page_num, e) for e in entries)
        print(f"  p.{page_num}: {page_count} products")
        n_total += page_count

    _record_source(conn, path.name, _sha1(path))
    return n_total


# --------------------------------------------------------------------------- #
#  Serrures_BDP_Novembre2024.pdf → locks_shabbat                              #
# --------------------------------------------------------------------------- #

LOCKS_PROMPT = """Extract every mechatronic lock reference from this document
as a JSON array. The document is the Beth Din de Paris's list of locks
certified for Shabbat / holiday use.

Emit ONE JSON entry per reference (a single company's row typically lists
many reference codes — split them; duplicate the company fields).

Each entry must have:
- "company":         manufacturer name as printed (e.g. "ABLOY France S.A.S",
                     "D. GUIDOTTI S.A.", "OPERA", "VALENTE SECURITE", "TESA").
- "company_address": company address on a single line, or null.
- "reference":       the model code exactly as printed (keep suffixes like
                     "CHABBAT", hyphens, slashes, letters).
- "identification":  how the end-user identifies the lock (e.g. "lettre « c »
                     sur la têtière", "marquage « R » sur la têtière"), or null.
- "conditions":      any special condition attached to this reference, for
                     example a mandatory clock or a pairing restriction.
                     Null if the entry has no extra condition.
- "locator":         "p.1".

Return ONLY the JSON array. No prose, no code fences."""


def extract_locks(slug: str, conn: sqlite3.Connection) -> int:
    import anthropic

    path = docs_dir(slug) / "Serrures_BDP_Novembre2024.pdf"
    if not path.exists():
        print(f"[{slug}] {path.name} not found, skipping")
        return 0

    client = anthropic.Anthropic()
    print(f"[{slug}] extracting {path.name} via {EXTRACTION_MODEL}…")
    resp = client.messages.create(
        model=EXTRACTION_MODEL,
        max_tokens=8192,
        messages=[{
            "role": "user",
            "content": [_pdf_document_block(path), {"type": "text", "text": LOCKS_PROMPT}],
        }],
    )
    raw = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
    entries = _extract_json_array(raw)

    conn.execute("DELETE FROM locks_shabbat WHERE source = ?", (path.name,))
    n = 0
    for e in entries:
        company = (e.get("company") or "").strip()
        reference = (e.get("reference") or "").strip()
        if not (company and reference):
            continue
        conn.execute(
            """INSERT INTO locks_shabbat
               (company, company_normalized, company_address,
                reference, reference_normalized,
                identification, conditions, source, locator)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                company,
                normalize_name(company),
                (e.get("company_address") or None),
                reference,
                normalize_name(reference),
                (e.get("identification") or None),
                (e.get("conditions") or None),
                path.name,
                e.get("locator") or "p.1",
            ),
        )
        n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


# --------------------------------------------------------------------------- #
#  Consistoire organigramme.pdf → organigramme                                #
# --------------------------------------------------------------------------- #

ORGA_PROMPT = """This document is the Consistoire de Paris's organisational
chart. It is a visual diagram — read it as an image and extract every
service / role / person / contact.

Emit a JSON array where each entry is a leaf node (a named role or
service with its own contact info, or a visible service box).

Each entry must have:
- "service":        the service or department name shown in the box
                    (e.g. "Mariages", "Hevra Kadicha", "Talmud Torah",
                    "Direction", "Secrétariat", "Administration").
- "parent_service": the parent box if the chart nests services under a
                    top-level umbrella (e.g. "Services B2C"); else null.
- "role":           title printed with the person (e.g. "Grand Rabbin",
                    "Directeur", "Dayan", "Responsable"); else null.
- "person":         the person's name as printed; null if the box only
                    names the service.
- "telephone":      phone number printed with that box, else null.
- "email":          email printed with that box, else null.
- "locator":        "p.1".

Rules:
- Preserve French accents and spellings.
- If the chart is purely a hierarchy of boxes without phone/email, still
  emit one entry per distinct service so the voice agent can at least
  acknowledge that service exists.
- Do NOT invent contact information that isn't written in the chart.

Return ONLY the JSON array. No prose, no code fences."""


def extract_organigramme(slug: str, conn: sqlite3.Connection) -> int:
    import anthropic

    path = docs_dir(slug) / "Consistoire organigramme.pdf"
    if not path.exists():
        print(f"[{slug}] {path.name} not found, skipping")
        return 0

    client = anthropic.Anthropic()
    print(f"[{slug}] extracting {path.name} via {EXTRACTION_MODEL}…")
    resp = client.messages.create(
        model=EXTRACTION_MODEL,
        max_tokens=8192,
        messages=[{
            "role": "user",
            "content": [_pdf_document_block(path), {"type": "text", "text": ORGA_PROMPT}],
        }],
    )
    raw = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
    entries = _extract_json_array(raw)

    conn.execute("DELETE FROM organigramme WHERE source = ?", (path.name,))
    n = 0
    for e in entries:
        service = (e.get("service") or "").strip()
        if not service:
            continue
        conn.execute(
            """INSERT INTO organigramme
               (service, role, person, telephone, email, parent_service, source, locator)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                service,
                (e.get("role") or None),
                (e.get("person") or None),
                (e.get("telephone") or None),
                (e.get("email") or None),
                (e.get("parent_service") or None),
                path.name,
                e.get("locator") or "p.1",
            ),
        )
        n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


def extract_mikvaot_csv(slug: str, conn: sqlite3.Connection) -> int:
    """Load mikvaot from the CSV produced by crawl_mikvaot.py (preferred over PDF)."""
    path = docs_dir(slug) / "mikvaot.csv"
    if not path.exists():
        print(f"[{slug}] mikvaot.csv not found, falling back to PDF extractor")
        return extract_mikvaot(slug, conn)

    conn.execute("DELETE FROM mikvaot WHERE source = ?", (path.name,))
    n = 0
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader, start=2):
            adresse = (row.get("adresse") or "").strip()
            if not adresse:
                continue
            conn.execute(
                """INSERT INTO mikvaot
                   (nom, adresse, code_postal, ville, telephone, contacts, usage, notes, source, locator)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    (row.get("nom") or None),
                    adresse,
                    (row.get("code_postal") or None),
                    (row.get("ville") or None),
                    (row.get("telephone") or None),
                    (row.get("contacts") or None),
                    (row.get("usage") or None),
                    None,
                    path.name,
                    f"row {i}",
                ),
            )
            n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


def extract_fish_csv(slug: str, conn: sqlite3.Connection) -> int:
    """Load fish from the CSV produced by crawl_poissons.py (preferred over PDF)."""
    path = docs_dir(slug) / "poissons.csv"
    if not path.exists():
        print(f"[{slug}] poissons.csv not found, falling back to PDF extractor")
        return extract_fish(slug, conn)

    conn.execute("DELETE FROM fish_species WHERE source = ?", (path.name,))
    n = 0
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader, start=2):
            nom = (row.get("nom") or "").strip()
            status = (row.get("status") or "autorise").strip()
            if not nom or status not in ("autorise", "interdit"):
                continue
            aliases_raw = (row.get("aliases") or "").strip()
            aliases = json.loads(aliases_raw) if aliases_raw else []
            aliases_norm = [normalize_name(a) for a in aliases]
            conn.execute(
                """INSERT INTO fish_species
                   (nom, nom_normalized, aliases, aliases_normalized,
                    status, notes, source, locator)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    nom,
                    normalize_name(nom),
                    json.dumps(aliases, ensure_ascii=False) if aliases else None,
                    json.dumps(aliases_norm) if aliases_norm else None,
                    status,
                    (row.get("notes") or None),
                    path.name,
                    f"row {i}",
                ),
            )
            n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


def extract_products_csv(slug: str, conn: sqlite3.Connection) -> int:
    """Load products from the CSV produced by crawl_produits.py (preferred over PDF)."""
    path = docs_dir(slug) / "produits.csv"
    if not path.exists():
        print(f"[{slug}] produits.csv not found, falling back to PDF extractor")
        return extract_products(slug, conn)

    conn.execute("DELETE FROM products WHERE source = ?", (path.name,))
    n = 0
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader, start=2):
            brand = (row.get("brand") or "").strip()
            nom = (row.get("nom") or "").strip()
            category = (row.get("category") or "").strip()
            status = (row.get("status") or "autorise").strip()
            if not (brand and nom and category):
                continue
            if status not in ("autorise", "tolere", "interdit"):
                status = "autorise"
            conn.execute(
                """INSERT INTO products
                   (category, brand, brand_normalized, line, nom, nom_normalized,
                    tags, notes, status, source, locator)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    category,
                    brand,
                    normalize_name(brand),
                    (row.get("line") or None),
                    nom,
                    normalize_name(nom),
                    (row.get("tags") or None),
                    (row.get("notes") or None),
                    status,
                    path.name,
                    f"row {i}",
                ),
            )
            n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


SALLES_PROMPT = """Extract every community hall (salle communautaire) listed
in this document as a JSON array.

Each entry must have:
- "nom": the hall's name if one is printed (e.g. "LES TOURNELLES",
  "LA VICTOIRE"). null if no name is given and the entry is identified
  only by its address.
- "adresse": full street address (without the postal code).
- "code_postal": 5-digit French postal code.
- "ville": commune name (e.g. "PARIS", "BOULOGNE", "CRÉTEIL").
- "telephone": phone number as printed (keep all digits/spaces). null if missing.
- "capacite": integer number of seats/places. null if not mentioned.
- "locator": "p.1".

Rules:
- The document is multi-column; read every column carefully.
- Postal codes appear before the street address (e.g. "75004 - 21 bis rue…").
- Capacity is written as "N places" after the phone number.
- For Paris entries the ville is "PARIS"; for suburbs use the commune name.

Return ONLY the JSON array. No prose, no code fences."""


def _extract_csv_table(slug: str, conn: sqlite3.Connection, filename: str, table: str, fields: list[str]) -> int:
    """Generic CSV → SQLite loader for simple flat tables."""
    path = docs_dir(slug) / filename
    if not path.exists():
        print(f"[{slug}] {filename} not found, skipping")
        return 0
    conn.execute(f"DELETE FROM {table} WHERE source = ?", (path.name,))
    placeholders = ", ".join("?" * (len(fields) + 2))
    col_list = ", ".join(fields + ["source", "locator"])
    n = 0
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader, start=2):
            first_val = (row.get(fields[0]) or "").strip()
            if not first_val:
                continue
            values = [(row.get(fld) or "").strip() or None for fld in fields]
            conn.execute(
                f"INSERT INTO {table} ({col_list}) VALUES ({placeholders})",
                values + [path.name, f"row {i}"],
            )
            n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


def extract_rabbins(slug: str, conn: sqlite3.Connection) -> int:
    return _extract_csv_table(slug, conn, "rabbins.csv", "rabbins",
        ["nom", "prenom", "fonction", "ville", "telephone", "email"])


def extract_talmud_torah(slug: str, conn: sqlite3.Connection) -> int:
    return _extract_csv_table(slug, conn, "talmud_torah.csv", "talmud_torah",
        ["nom", "adresse", "code_postal", "ville", "telephone", "email", "detail"])


def extract_aumoneries(slug: str, conn: sqlite3.Connection) -> int:
    return _extract_csv_table(slug, conn, "aumoneries.csv", "aumoneries",
        ["nom", "type", "lbl_type", "adresse", "code_postal", "ville", "telephone", "email", "detail"])


def extract_ecoles(slug: str, conn: sqlite3.Connection) -> int:
    return _extract_csv_table(slug, conn, "ecoles.csv", "ecoles",
        ["nom", "adresse", "code_postal", "ville", "telephone", "email", "detail"])


def extract_salles(slug: str, conn: sqlite3.Connection) -> int:
    import anthropic

    path = docs_dir(slug) / "Salles_Communautaires_5785.pdf"
    if not path.exists():
        print(f"[{slug}] Salles_Communautaires_5785.pdf not found, skipping")
        return 0

    client = anthropic.Anthropic()
    print(f"[{slug}] extracting {path.name} via {EXTRACTION_MODEL}…")
    chunks: list[str] = []
    with client.messages.stream(
        model=EXTRACTION_MODEL,
        max_tokens=8192,
        messages=[{
            "role": "user",
            "content": [_pdf_document_block(path), {"type": "text", "text": SALLES_PROMPT}],
        }],
    ) as stream:
        for t in stream.text_stream:
            chunks.append(t)
        final = stream.get_final_message()
    raw = "".join(chunks)
    if final.stop_reason == "max_tokens":
        print(f"  WARNING: hit max_tokens — JSON may be truncated")
    entries = _extract_json_array(raw)

    conn.execute("DELETE FROM salles WHERE source = ?", (path.name,))
    n = 0
    for e in entries:
        adresse = (e.get("adresse") or "").strip()
        cp = (e.get("code_postal") or "").strip()
        if not adresse or not cp:
            continue
        conn.execute(
            """INSERT INTO salles
               (nom, adresse, code_postal, ville, telephone, capacite, source, locator)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                (e.get("nom") or None),
                adresse,
                cp,
                (e.get("ville") or None),
                (e.get("telephone") or None),
                (int(e["capacite"]) if e.get("capacite") else None),
                path.name,
                e.get("locator") or "p.1",
            ),
        )
        n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


def extract_communautes(slug: str, conn: sqlite3.Connection) -> int:
    path = docs_dir(slug) / "communautes.csv"
    if not path.exists():
        print(f"[{slug}] communautes.csv not found, skipping")
        return 0

    conn.execute("DELETE FROM synagogues WHERE source = ?", (path.name,))
    n = 0
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader, start=2):
            nom = (row.get("nom") or "").strip()
            adresse = (row.get("adresse") or "").strip()
            if not nom:
                continue
            conn.execute(
                """INSERT INTO synagogues
                   (nom, adresse, code_postal, ville, telephone, email,
                    site, type, officials, source, locator)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    nom,
                    adresse,
                    (row.get("code_postal") or None),
                    (row.get("ville") or None),
                    (row.get("telephone") or None),
                    (row.get("email") or None),
                    (row.get("site") or None),
                    (row.get("type") or None),
                    (row.get("officials") or None),
                    path.name,
                    f"row {i}",
                ),
            )
            n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


def extract_organigramme_csv(slug: str, conn: sqlite3.Connection) -> int:
    """Load organigramme from the CSV produced by crawl_organigramme.py."""
    path = docs_dir(slug) / "organigramme.csv"
    if not path.exists():
        print(f"[{slug}] organigramme.csv not found, falling back to PDF extractor")
        return extract_organigramme(slug, conn)

    conn.execute("DELETE FROM organigramme WHERE source = ?", (path.name,))
    n = 0
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader, start=2):
            service = (row.get("service") or "").strip()
            if not service:
                continue
            conn.execute(
                """INSERT INTO organigramme
                   (service, role, person, telephone, email, parent_service, source, locator)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    service,
                    (row.get("role") or None),
                    (row.get("person") or None),
                    (row.get("telephone") or None),
                    (row.get("email") or None),
                    (row.get("parent_service") or None),
                    path.name,
                    f"row {i}",
                ),
            )
            n += 1
    _record_source(conn, path.name, _sha1(path))
    return n


EXTRACTORS = {
    "consistoire-paris": {
        "commerces":     extract_commerces,
        "mikvaot":       extract_mikvaot_csv,
        "marriages":     extract_marriages,
        "fish":          extract_fish_csv,
        "mohalim":       extract_mohalim,
        "products":      extract_products_csv,
        "locks":         extract_locks,
        "organigramme":  extract_organigramme_csv,
        "communautes":   extract_communautes,
        "salles":        extract_salles,
        "rabbins":       extract_rabbins,
        "talmud_torah":  extract_talmud_torah,
        "aumoneries":    extract_aumoneries,
        "ecoles":        extract_ecoles,
    },
}


def main() -> None:
    parser = argparse.ArgumentParser(description="(Re)build the structured fact graph.")
    parser.add_argument("slug", help="Use case slug")
    parser.add_argument(
        "--doc",
        choices=sorted({d for docs in EXTRACTORS.values() for d in docs}),
        help="Run only one collection extractor (default: all configured for the slug).",
    )
    args = parser.parse_args()

    configured = EXTRACTORS.get(args.slug)
    if not configured:
        print(f"[{args.slug}] no extractors configured — nothing to build")
        sys.exit(0)

    to_run = {args.doc: configured[args.doc]} if args.doc else configured
    conn = connect(args.slug)
    try:
        with conn:
            for name, fn in to_run.items():
                n = fn(args.slug, conn)
                print(f"[{args.slug}] {name}: {n} rows")
    finally:
        conn.close()
    print(f"[{args.slug}] wrote {db_path(args.slug)}")


if __name__ == "__main__":
    main()
