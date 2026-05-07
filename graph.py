"""Per-use-case structured fact graph (SQLite).

Complements the vector KB (`kb.py`) for callers who ask structured
questions — addresses, hours, phone numbers, arrondissements — where
fuzzy semantic retrieval is worse than an exact row lookup.

Layout:
    use_cases/<slug>/.graph/facts.db     SQLite, gitignored

Every row carries (source_file, locator) so the voice agent can cite
the source exactly, just like `kb.Chunk.citation()`.

Current scope: `consistoire-paris` only. Two collections:
    commerces  — kosher merchants (from commerces.csv)
    mikvaot    — ritual baths (from Mikvaot5785.pdf)

Add collections incrementally rather than designing for hypothetical
ones up front.
"""

from __future__ import annotations

import json
import re
import sqlite3
import unicodedata
from dataclasses import dataclass
from datetime import date
from pathlib import Path

USE_CASES_DIR = Path(__file__).parent / "use_cases"


def graph_dir(slug: str) -> Path:
    return USE_CASES_DIR / slug / ".graph"


def db_path(slug: str) -> Path:
    return graph_dir(slug) / "facts.db"


def has_graph(slug: str) -> bool:
    return db_path(slug).exists()


# --------------------------------------------------------------------------- #
#  Schema                                                                     #
# --------------------------------------------------------------------------- #

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
    filename   TEXT PRIMARY KEY,
    sha1       TEXT NOT NULL,
    built_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commerces (
    id           INTEGER PRIMARY KEY,
    nom          TEXT NOT NULL,
    type         TEXT NOT NULL,
    adresse      TEXT NOT NULL,
    code_postal  TEXT,
    ville        TEXT,
    telephone    TEXT,
    source       TEXT NOT NULL,
    locator      TEXT
);
CREATE INDEX IF NOT EXISTS idx_commerces_cp   ON commerces(code_postal);
CREATE INDEX IF NOT EXISTS idx_commerces_type ON commerces(type);
CREATE INDEX IF NOT EXISTS idx_commerces_nom  ON commerces(nom);

CREATE TABLE IF NOT EXISTS mikvaot (
    id            INTEGER PRIMARY KEY,
    nom           TEXT,
    adresse       TEXT NOT NULL,
    code_postal   TEXT,
    ville         TEXT,
    telephone     TEXT,
    contacts      TEXT,     -- free-form: 'Femmes: Mme X 06...'
    usage         TEXT,     -- 'femmes', 'hommes', 'vaisselle', combined
    notes         TEXT,
    source        TEXT NOT NULL,
    locator       TEXT
);
CREATE INDEX IF NOT EXISTS idx_mikvaot_cp    ON mikvaot(code_postal);
CREATE INDEX IF NOT EXISTS idx_mikvaot_usage ON mikvaot(usage);

CREATE TABLE IF NOT EXISTS marriage_forbidden_periods (
    id           INTEGER PRIMARY KEY,
    hebrew_year  TEXT NOT NULL,
    start_date   TEXT NOT NULL,    -- ISO YYYY-MM-DD
    end_date     TEXT NOT NULL,    -- ISO YYYY-MM-DD (inclusive)
    reason       TEXT NOT NULL,    -- 'Pessah', 'Omer', 'Kippour', ...
    rite         TEXT,             -- 'sefarade' | 'achkenaze' | NULL = both
    exceptions   TEXT,             -- JSON list of ISO dates (e.g. Lag Baomer)
    source       TEXT NOT NULL,
    locator      TEXT
);
CREATE INDEX IF NOT EXISTS idx_mfp_range ON marriage_forbidden_periods(start_date, end_date);

CREATE TABLE IF NOT EXISTS fish_species (
    id                  INTEGER PRIMARY KEY,
    nom                 TEXT NOT NULL,        -- canonical French name
    nom_normalized      TEXT NOT NULL,        -- lowercased, accents stripped
    aliases             TEXT,                 -- JSON list, original spellings
    aliases_normalized  TEXT,                 -- JSON list, normalized
    status              TEXT NOT NULL,        -- 'autorise' | 'interdit'
    notes               TEXT,
    source              TEXT NOT NULL,
    locator             TEXT
);
CREATE INDEX IF NOT EXISTS idx_fish_nom     ON fish_species(nom_normalized);
CREATE INDEX IF NOT EXISTS idx_fish_aliases ON fish_species(aliases_normalized);

CREATE TABLE IF NOT EXISTS mohalim (
    id             INTEGER PRIMARY KEY,
    civilite       TEXT,              -- 'M.' / 'Mme'
    prenom         TEXT NOT NULL,
    nom            TEXT NOT NULL,
    nom_normalized TEXT NOT NULL,     -- for case/accent-insensitive search
    telephone      TEXT NOT NULL,
    regions        TEXT NOT NULL,     -- JSON array, e.g. '["IDF"]', '["PACA"]'
    source         TEXT NOT NULL,
    locator        TEXT
);
CREATE INDEX IF NOT EXISTS idx_mohalim_nom ON mohalim(nom_normalized);

CREATE TABLE IF NOT EXISTS products (
    id                INTEGER PRIMARY KEY,
    category          TEXT NOT NULL,      -- breadcrumb, "BÉBÉ > ... > Céréales 4 mois+"
    brand             TEXT NOT NULL,
    brand_normalized  TEXT NOT NULL,
    line              TEXT,               -- e.g. 'MA 1ÈRE BLÉDINE'
    nom               TEXT NOT NULL,      -- variant, e.g. 'Nature sans gluten'
    nom_normalized    TEXT NOT NULL,
    tags              TEXT,               -- JSON array: ['L','B','SG','SL','N']
    notes             TEXT,
    status            TEXT NOT NULL,      -- 'autorise' | 'tolere' | 'interdit'
    source            TEXT NOT NULL,
    locator           TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_normalized);
CREATE INDEX IF NOT EXISTS idx_products_nom   ON products(nom_normalized);
CREATE INDEX IF NOT EXISTS idx_products_cat   ON products(category);

CREATE TABLE IF NOT EXISTS locks_shabbat (
    id                  INTEGER PRIMARY KEY,
    company             TEXT NOT NULL,
    company_normalized  TEXT NOT NULL,
    company_address     TEXT,
    reference           TEXT NOT NULL,
    reference_normalized TEXT NOT NULL,
    identification      TEXT,      -- how the user recognises the lock (letter 'c', etc.)
    conditions          TEXT,      -- special conditions (e.g. "clock required to neutralise ventouses")
    source              TEXT NOT NULL,
    locator             TEXT
);
CREATE INDEX IF NOT EXISTS idx_locks_company ON locks_shabbat(company_normalized);
CREATE INDEX IF NOT EXISTS idx_locks_ref     ON locks_shabbat(reference_normalized);

CREATE TABLE IF NOT EXISTS rabbins (
    id          INTEGER PRIMARY KEY,
    nom         TEXT NOT NULL,
    prenom      TEXT,
    fonction    TEXT,
    ville       TEXT,
    telephone   TEXT,
    email       TEXT,
    source      TEXT NOT NULL,
    locator     TEXT
);
CREATE INDEX IF NOT EXISTS idx_rabbins_nom      ON rabbins(nom);
CREATE INDEX IF NOT EXISTS idx_rabbins_fonction ON rabbins(fonction);
CREATE INDEX IF NOT EXISTS idx_rabbins_ville    ON rabbins(ville);

CREATE TABLE IF NOT EXISTS talmud_torah (
    id          INTEGER PRIMARY KEY,
    nom         TEXT,
    adresse     TEXT NOT NULL,
    code_postal TEXT,
    ville       TEXT,
    telephone   TEXT,
    email       TEXT,
    detail      TEXT,
    source      TEXT NOT NULL,
    locator     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tt_cp    ON talmud_torah(code_postal);
CREATE INDEX IF NOT EXISTS idx_tt_ville ON talmud_torah(ville);

CREATE TABLE IF NOT EXISTS aumoneries (
    id          INTEGER PRIMARY KEY,
    nom         TEXT NOT NULL,
    type        TEXT,
    lbl_type    TEXT,
    adresse     TEXT,
    code_postal TEXT,
    ville       TEXT,
    telephone   TEXT,
    email       TEXT,
    detail      TEXT,
    source      TEXT NOT NULL,
    locator     TEXT
);
CREATE INDEX IF NOT EXISTS idx_aumoneries_type ON aumoneries(type);

CREATE TABLE IF NOT EXISTS ecoles (
    id          INTEGER PRIMARY KEY,
    nom         TEXT NOT NULL,
    adresse     TEXT,
    code_postal TEXT,
    ville       TEXT,
    telephone   TEXT,
    email       TEXT,
    detail      TEXT,
    source      TEXT NOT NULL,
    locator     TEXT
);
CREATE INDEX IF NOT EXISTS idx_ecoles_cp    ON ecoles(code_postal);
CREATE INDEX IF NOT EXISTS idx_ecoles_ville ON ecoles(ville);

CREATE TABLE IF NOT EXISTS salles (
    id           INTEGER PRIMARY KEY,
    nom          TEXT,
    adresse      TEXT NOT NULL,
    code_postal  TEXT,
    ville        TEXT,
    telephone    TEXT,
    capacite     INTEGER,
    source       TEXT NOT NULL,
    locator      TEXT
);
CREATE INDEX IF NOT EXISTS idx_salles_cp    ON salles(code_postal);
CREATE INDEX IF NOT EXISTS idx_salles_ville ON salles(ville);

CREATE TABLE IF NOT EXISTS synagogues (
    id           INTEGER PRIMARY KEY,
    nom          TEXT NOT NULL,
    adresse      TEXT NOT NULL,
    code_postal  TEXT,
    ville        TEXT,
    telephone    TEXT,
    email        TEXT,
    site         TEXT,
    type         TEXT,     -- 'consistoriale' | 'associee' | 'autre'
    officials    TEXT,     -- JSON list: ["Officiant: Prénom NOM", ...]
    source       TEXT NOT NULL,
    locator      TEXT
);
CREATE INDEX IF NOT EXISTS idx_synagogues_cp    ON synagogues(code_postal);
CREATE INDEX IF NOT EXISTS idx_synagogues_ville ON synagogues(ville);
CREATE INDEX IF NOT EXISTS idx_synagogues_nom   ON synagogues(nom);

CREATE TABLE IF NOT EXISTS organigramme (
    id          INTEGER PRIMARY KEY,
    service     TEXT NOT NULL,           -- 'Mariages', 'Administration', ...
    role        TEXT,                    -- 'Grand Rabbin', 'Directeur', ...
    person      TEXT,                    -- person's name
    telephone   TEXT,
    email       TEXT,
    parent_service TEXT,                 -- breadcrumb parent, if any
    source      TEXT NOT NULL,
    locator     TEXT
);
CREATE INDEX IF NOT EXISTS idx_orga_service ON organigramme(service);
CREATE INDEX IF NOT EXISTS idx_orga_role    ON organigramme(role);
"""


def normalize_name(s: str) -> str:
    """Lowercase + strip diacritics. Used for fuzzy French-name matching
    on the fish list ('Mérou' ~ 'merou' ~ 'MEROU')."""
    s = unicodedata.normalize("NFD", s.lower().strip())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


def connect(slug: str) -> sqlite3.Connection:
    graph_dir(slug).mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path(slug))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


# --------------------------------------------------------------------------- #
#  Query layer                                                                #
# --------------------------------------------------------------------------- #

@dataclass
class Row:
    """A single result, rendered as one citable line for the voice agent."""
    text: str
    source: str
    locator: str

    def format(self) -> str:
        cite = f"[{self.source}:{self.locator}]" if self.locator else f"[{self.source}]"
        return f"- {cite} {self.text}"


_PARIS_CP = re.compile(r"^75\d{3}$")


def _arrondissement(code_postal: str | None) -> int | None:
    """Paris arrondissement number from code postal, else None."""
    if not code_postal or not _PARIS_CP.match(code_postal):
        return None
    return int(code_postal[-2:])


class GraphIndex:
    """Thin read-only wrapper around the SQLite facts DB."""

    def __init__(self, slug: str):
        self.slug = slug
        # check_same_thread=False so agent.py can call query methods from
        # `asyncio.to_thread` workers (different thread than the one that
        # opened the connection). Safe for this usage because the connection
        # is read-only — writes happen in `graph_build.py` using a separate
        # connection via `connect()`.
        self.conn = sqlite3.connect(db_path(slug), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row

    @classmethod
    def load(cls, slug: str) -> "GraphIndex | None":
        return cls(slug) if has_graph(slug) else None

    def close(self) -> None:
        self.conn.close()

    # -- commerces --------------------------------------------------------- #

    def find_commerces(
        self,
        *,
        type_: str | None = None,
        code_postal: str | None = None,
        arrondissement: int | None = None,
        ville: str | None = None,
        nom_like: str | None = None,
        limit: int = 10,
    ) -> list[Row]:
        clauses: list[str] = []
        params: list[str] = []
        if type_:
            clauses.append("LOWER(type) LIKE ?")
            params.append(f"%{type_.lower()}%")
        if code_postal:
            clauses.append("code_postal = ?")
            params.append(code_postal)
        if arrondissement is not None:
            clauses.append("code_postal IN (?, ?)")
            params.extend([f"750{arrondissement:02d}", f"751{arrondissement:02d}"])
        if ville:
            clauses.append("LOWER(ville) LIKE ?")
            params.append(f"%{ville.lower()}%")
        if nom_like:
            clauses.append("LOWER(nom) LIKE ?")
            params.append(f"%{nom_like.lower()}%")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"""
            SELECT nom, type, adresse, code_postal, ville, telephone, source, locator
            FROM commerces {where}
            ORDER BY nom LIMIT ?
        """
        params.append(str(limit))
        rows = self.conn.execute(sql, params).fetchall()
        return [
            Row(
                text=f"{r['nom']} ({r['type']}) — {r['adresse']} — {r['telephone'] or 'tél. n.c.'}",
                source=r["source"],
                locator=r["locator"] or "",
            )
            for r in rows
        ]

    # -- mikvaot ----------------------------------------------------------- #

    def find_mikvaot(
        self,
        *,
        code_postal: str | None = None,
        arrondissement: int | None = None,
        ville: str | None = None,
        usage: str | None = None,  # 'femmes' | 'hommes' | 'vaisselle'
        limit: int = 10,
    ) -> list[Row]:
        clauses: list[str] = []
        params: list[str] = []
        if code_postal:
            clauses.append("code_postal = ?")
            params.append(code_postal)
        if arrondissement is not None:
            clauses.append("code_postal IN (?, ?)")
            params.extend([f"750{arrondissement:02d}", f"751{arrondissement:02d}"])
        if ville:
            clauses.append("LOWER(ville) LIKE ?")
            params.append(f"%{ville.lower()}%")
        if usage:
            clauses.append("LOWER(usage) LIKE ?")
            params.append(f"%{usage.lower()}%")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"""
            SELECT nom, adresse, code_postal, ville, telephone, contacts, usage, notes, source, locator
            FROM mikvaot {where}
            ORDER BY code_postal, nom LIMIT ?
        """
        params.append(str(limit))
        rows = self.conn.execute(sql, params).fetchall()
        out: list[Row] = []
        for r in rows:
            bits = [r["nom"] or "Mikvé", "—", r["adresse"]]
            if r["usage"]:
                bits.append(f"({r['usage']})")
            if r["telephone"]:
                bits.append(f"— {r['telephone']}")
            if r["contacts"]:
                bits.append(f"— {r['contacts']}")
            out.append(Row(
                text=" ".join(bits),
                source=r["source"],
                locator=r["locator"] or "",
            ))
        return out

    # -- mariages --------------------------------------------------------- #

    # Source citation used for the Shabbat answer (no row in the table —
    # the PDF states "Tous les chabbatot" once, as a standing rule).
    _MARRIAGE_SOURCE = "Mariages_interdits_5786_5790.pdf"

    def check_marriage_date(self, iso_date: str, rite: str | None = None) -> str:
        """Is a religious marriage permitted on `iso_date`?

        Returns a pre-formatted verdict + citations, suitable for the
        voice agent to paraphrase aloud.

        `rite` is the groom's rite ('sefarade' or 'achkenaze'). When None,
        Omer periods of both rites are returned so the agent can follow up.
        """
        try:
            d = date.fromisoformat(iso_date)
        except ValueError:
            return f"Date invalide: {iso_date!r}. Format attendu: YYYY-MM-DD."

        reasons: list[Row] = []

        if d.weekday() == 5:  # Samedi: Shabbat
            reasons.append(Row(
                text=f"Le {iso_date} tombe un Shabbat — les mariages sont interdits tous les chabbatot.",
                source=self._MARRIAGE_SOURCE,
                locator="préambule",
            ))

        sql = """
            SELECT hebrew_year, start_date, end_date, reason, rite, exceptions, source, locator
            FROM marriage_forbidden_periods
            WHERE start_date <= ? AND end_date >= ?
        """
        params: list[str] = [iso_date, iso_date]
        if rite:
            sql += " AND (rite IS NULL OR rite = ?)"
            params.append(rite)
        for r in self.conn.execute(sql, params).fetchall():
            excepted = json.loads(r["exceptions"]) if r["exceptions"] else []
            if iso_date in excepted:
                continue
            rite_note = f" (rite {r['rite']})" if r["rite"] else ""
            range_note = r["start_date"] if r["start_date"] == r["end_date"] else f"du {r['start_date']} au {r['end_date']}"
            reasons.append(Row(
                text=f"{r['reason']} {r['hebrew_year']}{rite_note} — période interdite {range_note}.",
                source=r["source"],
                locator=r["locator"] or "",
            ))

        if not reasons:
            cite = f"[{self._MARRIAGE_SOURCE}]"
            return f"OUI. Aucun interdit trouvé pour le {iso_date} selon le calendrier du Consistoire. {cite}"
        lines = [f"NON, le {iso_date} n'est pas autorisé."]
        lines.extend(r.format() for r in reasons)
        return "\n".join(lines)

    # -- poissons --------------------------------------------------------- #

    _FISH_SOURCE = "Poissons_Autorises_avec_photos5785.pdf"

    def lookup_fish(self, name: str) -> str:
        """Is `name` a Consistoire-authorized fish?

        Matches canonical name then aliases (both accent-insensitive),
        falls back to a substring search with suggestions. If nothing
        resembles the query, returns a prudent "pas dans la liste"
        rather than claiming it's forbidden — many obscure species are
        simply not enumerated.
        """
        q = normalize_name(name)
        if not q:
            return "Nom de poisson vide."

        row = self.conn.execute(
            """SELECT nom, aliases, status, notes, locator
               FROM fish_species WHERE nom_normalized = ?""",
            (q,),
        ).fetchone()
        if row is None:
            # aliases_normalized stores a JSON array of normalized strings;
            # the LIKE pattern looks for the exact quoted element.
            row = self.conn.execute(
                """SELECT nom, aliases, status, notes, locator
                   FROM fish_species WHERE aliases_normalized LIKE ?""",
                (f'%"{q}"%',),
            ).fetchone()
        if row is not None:
            return self._format_fish_verdict(row, name)

        # Fuzzy fallback: substring suggestions.
        suggestions = self.conn.execute(
            """SELECT DISTINCT nom FROM fish_species
               WHERE nom_normalized LIKE ? OR aliases_normalized LIKE ?
               ORDER BY nom LIMIT 5""",
            (f"%{q}%", f"%{q}%"),
        ).fetchall()
        cite = f"[{self._FISH_SOURCE}]"
        if suggestions:
            names = ", ".join(s["nom"] for s in suggestions)
            return (
                f"Aucune correspondance exacte pour « {name} » dans la liste du Consistoire. "
                f"Vous pensiez peut-être à: {names}. {cite}"
            )
        return (
            f"« {name} » ne figure pas dans la liste officielle des poissons "
            f"autorisés par le Consistoire. Je recommande de vérifier avec un rabbin. {cite}"
        )

    def _format_fish_verdict(self, row: sqlite3.Row, query: str) -> str:
        aliases = json.loads(row["aliases"]) if row["aliases"] else []
        cite = f"[{self._FISH_SOURCE}:{row['locator']}]" if row["locator"] else f"[{self._FISH_SOURCE}]"
        alias_txt = f" (aussi appelé {', '.join(aliases)})" if aliases else ""
        notes_txt = f" Note: {row['notes']}" if row["notes"] else ""
        if row["status"] == "autorise":
            return f"OUI. {cite} {row['nom']}{alias_txt} figure dans la liste autorisée.{notes_txt}"
        return f"NON. {cite} {row['nom']}{alias_txt} est explicitement interdit.{notes_txt}"

    # -- mohalim ---------------------------------------------------------- #

    _MOHALIM_SOURCE = "AFM_Mohalim0924.pdf"

    def find_mohalim(
        self,
        *,
        region: str | None = None,   # 'IDF' | 'PACA' | 'Bas-Rhin' | ...
        nom_like: str | None = None,
        limit: int = 20,
    ) -> list[Row]:
        """Mohalim registry from the AFM. Regions stored as JSON arrays;
        a mohel can serve multiple (e.g. '["IDF", "PACA"]')."""
        clauses: list[str] = []
        params: list[str] = []
        if region:
            # Match quoted element inside the JSON array column.
            clauses.append("regions LIKE ?")
            params.append(f'%"{region}"%')
        if nom_like:
            clauses.append("nom_normalized LIKE ?")
            params.append(f"%{normalize_name(nom_like)}%")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"""
            SELECT civilite, prenom, nom, telephone, regions, source, locator
            FROM mohalim {where}
            ORDER BY nom LIMIT ?
        """
        params.append(str(limit))
        rows = self.conn.execute(sql, params).fetchall()
        out: list[Row] = []
        for r in rows:
            regions = json.loads(r["regions"]) if r["regions"] else []
            civ = f"{r['civilite']} " if r["civilite"] else ""
            region_txt = f" ({', '.join(regions)})" if regions else ""
            out.append(Row(
                text=f"{civ}{r['prenom']} {r['nom']} — {r['telephone']}{region_txt}",
                source=r["source"],
                locator=r["locator"] or "",
            ))
        return out

    # -- produits --------------------------------------------------------- #

    _PRODUCTS_SOURCE = "Consistoire-Produits2025-2026.pdf"

    # Tag legend used when paraphrasing to the caller. Kept here so the
    # verdict string is self-explanatory without a second lookup.
    _TAG_LEGEND = {
        "L":  "laitier",
        "B":  "bio",
        "SG": "sans gluten",
        "SL": "sans lactose",
        "N":  "neutre (parvé)",
    }

    def lookup_product(
        self,
        *,
        brand: str | None = None,
        product_name: str | None = None,
        category: str | None = None,
        tag: str | None = None,
        limit: int = 10,
    ) -> str:
        """Look up one or more entries in the Beth Din product catalog.

        Returns a pre-formatted verdict-per-line string, citation-aware.
        When nothing matches, returns a "pas dans la liste" fallback
        that callers of the voice agent must NOT paraphrase as
        "interdit" — absent products are simply not certified, which is
        different from being forbidden.
        """
        clauses: list[str] = []
        params: list[str] = []
        if brand:
            clauses.append("brand_normalized LIKE ?")
            params.append(f"%{normalize_name(brand)}%")
        if product_name:
            q = normalize_name(product_name)
            clauses.append("(nom_normalized LIKE ? OR LOWER(line) LIKE ?)")
            params.extend([f"%{q}%", f"%{product_name.lower()}%"])
        if category:
            clauses.append("LOWER(category) LIKE ?")
            params.append(f"%{category.lower()}%")
        if tag:
            clauses.append("tags LIKE ?")
            params.append(f'%"{tag}"%')
        if not clauses:
            return "Précisez au moins une marque, un produit, une catégorie ou un tag."

        where = " AND ".join(clauses)
        sql = f"""
            SELECT brand, line, nom, tags, notes, status, category, source, locator
            FROM products WHERE {where}
            ORDER BY brand, nom LIMIT ?
        """
        params.append(str(limit))
        rows = self.conn.execute(sql, params).fetchall()
        cite_root = f"[{self._PRODUCTS_SOURCE}]"
        if not rows:
            criteria = ", ".join(
                f"{k}={v!r}" for k, v in
                {"brand": brand, "product_name": product_name, "category": category, "tag": tag}.items()
                if v
            )
            return (
                f"Aucun produit ne correspond à {criteria} dans la liste officielle du Beth Din. "
                f"Attention: absence de la liste ≠ interdiction. Conseillez au fidèle de vérifier "
                f"auprès de l'ACIP. {cite_root}"
            )

        status_prefix = {"autorise": "AUTORISÉ", "tolere": "TOLÉRÉ", "interdit": "INTERDIT"}
        lines: list[str] = []
        for r in rows:
            tags = json.loads(r["tags"]) if r["tags"] else []
            tag_txt = ""
            if tags:
                readable = [self._TAG_LEGEND.get(t, t) for t in tags]
                tag_txt = f" ({', '.join(readable)})"
            line_part = f" {r['line']}" if r["line"] else ""
            notes_part = f" — {r['notes']}" if r["notes"] else ""
            cite = f"[{self._PRODUCTS_SOURCE}:{r['locator']}]" if r["locator"] else cite_root
            lines.append(
                f"[{status_prefix.get(r['status'], r['status'])}] {cite} "
                f"{r['brand']}{line_part}: {r['nom']}{tag_txt}{notes_part} "
                f"· catégorie: {r['category']}"
            )
        return "\n".join(lines)

    # -- serrures --------------------------------------------------------- #

    _LOCKS_SOURCE = "Serrures_BDP_Novembre2024.pdf"

    def lookup_lock(
        self,
        *,
        reference: str | None = None,
        company: str | None = None,
        limit: int = 10,
    ) -> str:
        """Is a given mechatronic lock reference approved for Shabbat use?"""
        clauses: list[str] = []
        params: list[str] = []
        if reference:
            clauses.append("reference_normalized LIKE ?")
            params.append(f"%{normalize_name(reference)}%")
        if company:
            clauses.append("company_normalized LIKE ?")
            params.append(f"%{normalize_name(company)}%")
        if not clauses:
            return "Précisez une référence ou une société."

        sql = f"""
            SELECT company, company_address, reference, identification, conditions, source, locator
            FROM locks_shabbat WHERE {' AND '.join(clauses)}
            ORDER BY company, reference LIMIT ?
        """
        params.append(str(limit))
        rows = self.conn.execute(sql, params).fetchall()
        cite_root = f"[{self._LOCKS_SOURCE}]"
        if not rows:
            return (
                f"Cette référence ne figure pas sur la liste des serrures mécatroniques "
                f"certifiées par le Beth Din de Paris pour un usage le Chabbat. "
                f"Tout autre système électrique/électronique est non conforme sauf certification écrite. {cite_root}"
            )
        lines: list[str] = []
        for r in rows:
            cite = f"[{self._LOCKS_SOURCE}:{r['locator']}]" if r["locator"] else cite_root
            ident = f" — identification: {r['identification']}" if r["identification"] else ""
            cond = f" — condition: {r['conditions']}" if r["conditions"] else ""
            lines.append(
                f"[CERTIFIÉ CHABBAT] {cite} {r['company']} — {r['reference']}{ident}{cond}"
            )
        return "\n".join(lines)

    # -- rabbins ---------------------------------------------------------- #

    def find_rabbin(
        self,
        *,
        nom_like: str | None = None,
        fonction: str | None = None,
        ville: str | None = None,
        limit: int = 10,
    ) -> list[Row]:
        clauses, params = [], []
        if nom_like:
            clauses.append("(LOWER(nom) LIKE ? OR LOWER(prenom) LIKE ?)")
            params.extend([f"%{nom_like.lower()}%", f"%{nom_like.lower()}%"])
        if fonction:
            clauses.append("LOWER(fonction) LIKE ?")
            params.append(f"%{fonction.lower()}%")
        if ville:
            clauses.append("LOWER(ville) LIKE ?")
            params.append(f"%{ville.lower()}%")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"SELECT prenom, nom, fonction, ville, telephone, email, source, locator FROM rabbins {where} ORDER BY nom LIMIT ?"
        params.append(str(limit))
        out = []
        for r in self.conn.execute(sql, params).fetchall():
            name = f"{r['prenom']} {r['nom']}".strip()
            fn = f" — {r['fonction']}" if r["fonction"] else ""
            ville_txt = f" ({r['ville']})" if r["ville"] else ""
            tel = f" — {r['telephone']}" if r["telephone"] else ""
            email = f" — {r['email']}" if r["email"] else ""
            out.append(Row(text=f"{name}{fn}{ville_txt}{tel}{email}", source=r["source"], locator=r["locator"] or ""))
        return out

    # -- talmud torah ----------------------------------------------------- #

    def find_talmud_torah(
        self,
        *,
        code_postal: str | None = None,
        arrondissement: int | None = None,
        ville: str | None = None,
        limit: int = 10,
    ) -> list[Row]:
        clauses, params = [], []
        if code_postal:
            clauses.append("code_postal = ?")
            params.append(code_postal)
        if arrondissement is not None:
            clauses.append("code_postal IN (?, ?)")
            params.extend([f"750{arrondissement:02d}", f"751{arrondissement:02d}"])
        if ville:
            clauses.append("LOWER(ville) LIKE ?")
            params.append(f"%{ville.lower()}%")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"SELECT nom, adresse, ville, telephone, email, detail, source, locator FROM talmud_torah {where} ORDER BY ville LIMIT ?"
        params.append(str(limit))
        out = []
        for r in self.conn.execute(sql, params).fetchall():
            nom = r["nom"] or "Centre Talmud Torah"
            tel = f" — {r['telephone']}" if r["telephone"] else ""
            detail = f" — {r['detail']}" if r["detail"] else ""
            out.append(Row(text=f"{nom} — {r['adresse']}, {r['ville']}{tel}{detail}", source=r["source"], locator=r["locator"] or ""))
        return out

    # -- aumôneries ------------------------------------------------------- #

    def find_aumonerie(
        self,
        *,
        type_: str | None = None,
        ville: str | None = None,
        limit: int = 10,
    ) -> list[Row]:
        clauses, params = [], []
        if type_:
            clauses.append("(LOWER(type) LIKE ? OR LOWER(lbl_type) LIKE ?)")
            params.extend([f"%{type_.lower()}%", f"%{type_.lower()}%"])
        if ville:
            clauses.append("LOWER(ville) LIKE ?")
            params.append(f"%{ville.lower()}%")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"SELECT nom, lbl_type, ville, telephone, email, detail, source, locator FROM aumoneries {where} ORDER BY lbl_type, nom LIMIT ?"
        params.append(str(limit))
        out = []
        for r in self.conn.execute(sql, params).fetchall():
            lbl = f" [{r['lbl_type']}]" if r["lbl_type"] else ""
            loc = f" — {r['ville']}" if r["ville"] else ""
            tel = f" — {r['telephone']}" if r["telephone"] else ""
            detail = f" — {r['detail']}" if r["detail"] else ""
            out.append(Row(text=f"{r['nom']}{lbl}{loc}{tel}{detail}", source=r["source"], locator=r["locator"] or ""))
        return out

    # -- écoles ----------------------------------------------------------- #

    def find_ecole(
        self,
        *,
        code_postal: str | None = None,
        arrondissement: int | None = None,
        ville: str | None = None,
        nom_like: str | None = None,
        limit: int = 10,
    ) -> list[Row]:
        clauses, params = [], []
        if code_postal:
            clauses.append("code_postal = ?")
            params.append(code_postal)
        if arrondissement is not None:
            clauses.append("code_postal IN (?, ?)")
            params.extend([f"750{arrondissement:02d}", f"751{arrondissement:02d}"])
        if ville:
            clauses.append("LOWER(ville) LIKE ?")
            params.append(f"%{ville.lower()}%")
        if nom_like:
            clauses.append("LOWER(nom) LIKE ?")
            params.append(f"%{nom_like.lower()}%")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"SELECT nom, adresse, ville, telephone, email, detail, source, locator FROM ecoles {where} ORDER BY ville, nom LIMIT ?"
        params.append(str(limit))
        out = []
        for r in self.conn.execute(sql, params).fetchall():
            tel = f" — {r['telephone']}" if r["telephone"] else ""
            detail = f" — {r['detail']}" if r["detail"] else ""
            out.append(Row(text=f"{r['nom']} — {r['adresse'] or ''}, {r['ville']}{tel}{detail}", source=r["source"], locator=r["locator"] or ""))
        return out

    # -- salles communautaires -------------------------------------------- #

    _SALLES_SOURCE = "Salles_Communautaires_5785.pdf"

    def find_salles(
        self,
        *,
        code_postal: str | None = None,
        arrondissement: int | None = None,
        ville: str | None = None,
        capacite_min: int | None = None,
        limit: int = 10,
    ) -> list[Row]:
        """Find community halls available for events."""
        clauses: list[str] = []
        params: list[str] = []
        if code_postal:
            clauses.append("code_postal = ?")
            params.append(code_postal)
        if arrondissement is not None:
            clauses.append("code_postal IN (?, ?)")
            params.extend([f"750{arrondissement:02d}", f"751{arrondissement:02d}"])
        if ville:
            clauses.append("LOWER(ville) LIKE ?")
            params.append(f"%{ville.lower()}%")
        if capacite_min is not None:
            clauses.append("capacite >= ?")
            params.append(str(capacite_min))
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"""
            SELECT nom, adresse, code_postal, ville, telephone, capacite, source, locator
            FROM salles {where}
            ORDER BY ville, capacite DESC LIMIT ?
        """
        params.append(str(limit))
        rows = self.conn.execute(sql, params).fetchall()
        out: list[Row] = []
        for r in rows:
            nom_txt = f"{r['nom']} — " if r["nom"] else ""
            cap_txt = f" — {r['capacite']} places" if r["capacite"] else ""
            tel_txt = f" — {r['telephone']}" if r["telephone"] else ""
            out.append(Row(
                text=f"{nom_txt}{r['adresse']}, {r['ville']}{cap_txt}{tel_txt}",
                source=r["source"],
                locator=r["locator"] or "",
            ))
        return out

    # -- synagogues ------------------------------------------------------- #

    _SYNAGOGUES_SOURCE = "communautes.csv"

    def find_synagogues(
        self,
        *,
        code_postal: str | None = None,
        arrondissement: int | None = None,
        ville: str | None = None,
        nom_like: str | None = None,
        type_: str | None = None,
        limit: int = 10,
    ) -> list[Row]:
        """Find synagogues and Jewish communities by location or name."""
        clauses: list[str] = []
        params: list[str] = []
        if code_postal:
            clauses.append("code_postal = ?")
            params.append(code_postal)
        if arrondissement is not None:
            clauses.append("code_postal IN (?, ?)")
            params.extend([f"750{arrondissement:02d}", f"751{arrondissement:02d}"])
        if ville:
            clauses.append("LOWER(ville) LIKE ?")
            params.append(f"%{ville.lower()}%")
        if nom_like:
            clauses.append("LOWER(nom) LIKE ?")
            params.append(f"%{nom_like.lower()}%")
        if type_:
            clauses.append("type = ?")
            params.append(type_)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"""
            SELECT nom, adresse, code_postal, ville, telephone, email, type, officials, source, locator
            FROM synagogues {where}
            ORDER BY ville, nom LIMIT ?
        """
        params.append(str(limit))
        rows = self.conn.execute(sql, params).fetchall()
        out: list[Row] = []
        for r in rows:
            type_txt = f" [{r['type']}]" if r["type"] else ""
            tel_txt = f" — {r['telephone']}" if r["telephone"] else ""
            email_txt = f" — {r['email']}" if r["email"] else ""
            officials = json.loads(r["officials"]) if r["officials"] else []
            official_txt = f" ({'; '.join(officials[:2])})" if officials else ""
            out.append(Row(
                text=f"{r['nom']}{type_txt} — {r['adresse']}, {r['ville']}{tel_txt}{email_txt}{official_txt}",
                source=r["source"],
                locator=r["locator"] or "",
            ))
        return out

    # -- organigramme ----------------------------------------------------- #

    _ORGA_SOURCE = "Consistoire organigramme.pdf"

    def find_contact(
        self,
        *,
        service: str | None = None,
        role: str | None = None,
        person_like: str | None = None,
        limit: int = 10,
    ) -> list[Row]:
        """Consistoire org chart lookup — who runs a given service, how to reach them."""
        clauses: list[str] = []
        params: list[str] = []
        if service:
            clauses.append("(LOWER(service) LIKE ? OR LOWER(parent_service) LIKE ?)")
            params.extend([f"%{service.lower()}%", f"%{service.lower()}%"])
        if role:
            clauses.append("LOWER(role) LIKE ?")
            params.append(f"%{role.lower()}%")
        if person_like:
            clauses.append("LOWER(person) LIKE ?")
            params.append(f"%{person_like.lower()}%")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"""
            SELECT service, role, person, telephone, email, parent_service, source, locator
            FROM organigramme {where}
            ORDER BY service, role LIMIT ?
        """
        params.append(str(limit))
        rows = self.conn.execute(sql, params).fetchall()
        out: list[Row] = []
        for r in rows:
            breadcrumb = f"{r['parent_service']} > {r['service']}" if r["parent_service"] else r["service"]
            role_txt = f" — {r['role']}" if r["role"] else ""
            person_txt = f" — {r['person']}" if r["person"] else ""
            contact: list[str] = []
            if r["telephone"]:
                contact.append(r["telephone"])
            if r["email"]:
                contact.append(r["email"])
            contact_txt = f" ({', '.join(contact)})" if contact else ""
            out.append(Row(
                text=f"{breadcrumb}{role_txt}{person_txt}{contact_txt}",
                source=r["source"],
                locator=r["locator"] or "",
            ))
        return out

    # -- formatting -------------------------------------------------------- #

    @staticmethod
    def format_rows(rows: list[Row], char_budget: int = 1500) -> str:
        if not rows:
            return "(aucun résultat)"
        parts: list[str] = []
        remaining = char_budget
        for row in rows:
            line = row.format()
            if len(line) > remaining:
                break
            parts.append(line)
            remaining -= len(line) + 1
        return "\n".join(parts)
