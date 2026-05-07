"""Per-use-case document knowledge base.

Layout:
    use_cases/<slug>/docs/        human-curated source documents (recursed;
                                  citations carry the path relative to docs/)
    use_cases/<slug>/.index/      build artifacts (gitignored)
        chunks.jsonl              one JSON chunk per line
        embeddings.npy            float32 matrix aligned to chunks

Runtime (`DocsIndex.load`) mmaps the embedding matrix and keeps chunks
in memory. Query-time cost is one OpenAI embedding call (~300ms) plus
a cosine scan over the in-memory matrix (milliseconds for <20k chunks).

Build with: python kb_build.py <slug>   (or --all)
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np

USE_CASES_DIR = Path(__file__).parent / "use_cases"
EMBED_MODEL = "voyage-3-large"    # 1024-dim, multilingual, strong FR quality
EMBED_DIM = 1024
CHUNK_TOKENS = 500
CHUNK_OVERLAP = 50
# Rough token count; good enough for chunking, not billed.
_APPROX_CHARS_PER_TOKEN = 4


# --------------------------------------------------------------------------- #
#  Path helpers                                                               #
# --------------------------------------------------------------------------- #

def docs_dir(slug: str) -> Path:
    return USE_CASES_DIR / slug / "docs"


def index_dir(slug: str) -> Path:
    return USE_CASES_DIR / slug / ".index"


def has_docs(slug: str) -> bool:
    d = docs_dir(slug)
    return d.is_dir() and any(d.iterdir())


# --------------------------------------------------------------------------- #
#  Chunk model                                                                #
# --------------------------------------------------------------------------- #

@dataclass
class Chunk:
    source: str          # filename relative to docs/
    locator: str         # e.g. "p.12", "§Pessah", "line 140"
    text: str
    source_hash: str     # SHA-1 of the source file at build time

    def citation(self) -> str:
        return f"[{self.source}:{self.locator}]" if self.locator else f"[{self.source}]"


# --------------------------------------------------------------------------- #
#  Extraction                                                                 #
# --------------------------------------------------------------------------- #

def _extract_pdf(path: Path) -> list[tuple[str, str]]:
    """Return [(locator, text)] per page."""
    import pdfplumber
    out: list[tuple[str, str]] = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages, start=1):
            text = (page.extract_text() or "").strip()
            if text:
                out.append((f"p.{i}", text))
    return out


def _extract_docx(path: Path) -> list[tuple[str, str]]:
    import docx
    d = docx.Document(str(path))
    paragraphs = [p.text for p in d.paragraphs if p.text.strip()]
    text = "\n".join(paragraphs).strip()
    return [("", text)] if text else []


def _extract_markdown(path: Path) -> list[tuple[str, str]]:
    """Split markdown on H1/H2 headings so each chunk has a locator."""
    text = path.read_text(encoding="utf-8")
    sections: list[tuple[str, str]] = []
    current_locator = ""
    current_lines: list[str] = []

    def flush() -> None:
        body = "\n".join(current_lines).strip()
        if body:
            sections.append((current_locator, body))

    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("# ") or stripped.startswith("## "):
            flush()
            current_locator = f"§{stripped.lstrip('#').strip()}"
            current_lines = []
        else:
            current_lines.append(line)
    flush()
    return sections or [("", text.strip())]


def _extract_plain(path: Path) -> list[tuple[str, str]]:
    text = path.read_text(encoding="utf-8").strip()
    return [("", text)] if text else []


def _extract_csv(path: Path) -> list[tuple[str, str]]:
    """One row per section. Locator = first-column value when it looks
    like a name, else the row number. Each row is rendered as
    `key: value` lines so queries can match field names and values.
    """
    import csv
    sections: list[tuple[str, str]] = []
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader, start=2):  # line 1 is header
            clean = {k: (v or "").strip() for k, v in row.items() if k}
            if not any(clean.values()):
                continue
            first_val = next(iter(clean.values()), "")
            locator = first_val[:60] if first_val else f"row {i}"
            body = "\n".join(f"{k}: {v}" for k, v in clean.items() if v)
            if body:
                sections.append((locator, body))
    return sections


_EXTRACTORS = {
    ".pdf": _extract_pdf,
    ".docx": _extract_docx,
    ".md": _extract_markdown,
    ".markdown": _extract_markdown,
    ".txt": _extract_plain,
    ".csv": _extract_csv,
}


def extract(path: Path) -> list[tuple[str, str]]:
    """Return [(locator, text)] for a single source file, or [] if unsupported."""
    fn = _EXTRACTORS.get(path.suffix.lower())
    return fn(path) if fn else []


# --------------------------------------------------------------------------- #
#  Chunking                                                                   #
# --------------------------------------------------------------------------- #

def _approx_tokens(text: str) -> int:
    return max(1, len(text) // _APPROX_CHARS_PER_TOKEN)


def chunk_text(text: str, max_tokens: int = CHUNK_TOKENS, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Sentence-aware chunking with token approximation.

    Greedy: accumulate sentences until we hit the token budget, then start
    a new chunk carrying the last `overlap` tokens' worth of sentences.
    """
    # Split on sentence boundaries, keeping the delimiter.
    import re
    sentences = re.split(r"(?<=[.!?…])\s+", text)
    sentences = [s.strip() for s in sentences if s.strip()]
    if not sentences:
        return []

    chunks: list[str] = []
    buf: list[str] = []
    buf_tokens = 0
    for sent in sentences:
        t = _approx_tokens(sent)
        if buf and buf_tokens + t > max_tokens:
            chunks.append(" ".join(buf))
            # Carry overlap
            carry: list[str] = []
            carry_tokens = 0
            for s in reversed(buf):
                carry.insert(0, s)
                carry_tokens += _approx_tokens(s)
                if carry_tokens >= overlap:
                    break
            buf = carry
            buf_tokens = carry_tokens
        buf.append(sent)
        buf_tokens += t
    if buf:
        chunks.append(" ".join(buf))
    return chunks


# --------------------------------------------------------------------------- #
#  Build pipeline                                                             #
# --------------------------------------------------------------------------- #

def _hash_file(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as f:
        for blob in iter(lambda: f.read(65536), b""):
            h.update(blob)
    return h.hexdigest()[:16]


# Names skipped anywhere under docs/: scraper artefacts and top-level catalogs
# that would dilute embeddings if indexed. Matched against any path part, so a
# `raw_html/` folder at any depth is excluded.
_KB_SKIP_NAMES = {"raw_html", "_scrape_report.json", "manifest.json", "index.md", "README.md"}
# CSV/PDF files that are already indexed in the structured graph — skip them
# in the vector KB to avoid redundancy and keep chunk count low.
_KB_SKIP_EXTENSIONS = {".csv", ".png", ".jpg", ".jpeg"}


def build_chunks_for_slug(slug: str) -> list[Chunk]:
    d = docs_dir(slug)
    chunks: list[Chunk] = []
    for path in sorted(d.rglob("*")):
        if not path.is_file():
            continue
        rel_parts = path.relative_to(d).parts
        if any(p.startswith(".") for p in rel_parts):
            continue
        if any(p in _KB_SKIP_NAMES for p in rel_parts):
            continue
        if path.suffix.lower() in _KB_SKIP_EXTENSIONS:
            continue
        sections = extract(path)
        if not sections:
            continue
        file_hash = _hash_file(path)
        rel_name = path.relative_to(d).as_posix()
        for locator, section_text in sections:
            for piece in chunk_text(section_text):
                chunks.append(Chunk(
                    source=rel_name,
                    locator=locator,
                    text=piece,
                    source_hash=file_hash,
                ))
    return chunks


def _voyage_client():
    import voyageai
    return voyageai.Client()  # VOYAGE_API_KEY from env


def embed_batch(texts: list[str], *, input_type: str) -> np.ndarray:
    """Embed via Voyage AI. `input_type` must be 'document' or 'query'
    — Voyage uses asymmetric retrieval; mixing types degrades recall.
    Returns (n, EMBED_DIM) float32.
    """
    import time

    if input_type not in ("document", "query"):
        raise ValueError(f"input_type must be 'document' or 'query', got {input_type!r}")
    client = _voyage_client()
    # Voyage caps at 128 texts per call for voyage-3-large.
    # Use smaller batches to stay under the 10K TPM free-tier limit.
    BATCH = 32
    out: list[list[float]] = []
    for i in range(0, len(texts), BATCH):
        batch = texts[i:i + BATCH]
        retries = 5
        delay = 20.0
        while retries:
            try:
                resp = client.embed(batch, model=EMBED_MODEL, input_type=input_type)
                out.extend(resp.embeddings)
                break
            except Exception as e:
                msg = str(e).lower()
                if "rate" in msg or "payment" in msg or "429" in msg:
                    retries -= 1
                    if retries == 0:
                        raise
                    print(f"  rate-limited, waiting {delay:.0f}s…")
                    time.sleep(delay)
                    delay = min(delay * 1.5, 60)
                else:
                    raise
        if i + BATCH < len(texts):
            time.sleep(5)  # stay well under 3 RPM on free tier
    return np.asarray(out, dtype=np.float32)


def build_index(slug: str) -> tuple[int, Path]:
    """(Re)build chunks.jsonl + embeddings.npy for a use case.

    Returns (n_chunks, index_dir_path).
    """
    chunks = build_chunks_for_slug(slug)
    idx = index_dir(slug)
    idx.mkdir(parents=True, exist_ok=True)

    chunks_path = idx / "chunks.jsonl"
    emb_path = idx / "embeddings.npy"

    if not chunks:
        # Wipe stale index if docs folder was emptied.
        chunks_path.unlink(missing_ok=True)
        emb_path.unlink(missing_ok=True)
        return 0, idx

    with chunks_path.open("w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(asdict(c), ensure_ascii=False) + "\n")

    matrix = embed_batch([c.text for c in chunks], input_type="document")
    np.save(emb_path, matrix)
    return len(chunks), idx


# --------------------------------------------------------------------------- #
#  Runtime index                                                              #
# --------------------------------------------------------------------------- #

class DocsIndex:
    def __init__(self, slug: str, chunks: list[Chunk], matrix: np.ndarray):
        self.slug = slug
        self.chunks = chunks
        # L2-normalize once for cosine-via-dot-product.
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        self.matrix = (matrix / norms).astype(np.float32)

    @classmethod
    def load(cls, slug: str) -> "DocsIndex | None":
        idx = index_dir(slug)
        chunks_path = idx / "chunks.jsonl"
        emb_path = idx / "embeddings.npy"
        if not chunks_path.exists() or not emb_path.exists():
            return None
        chunks = [Chunk(**json.loads(line)) for line in chunks_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        if not chunks:
            return None
        matrix = np.load(emb_path, mmap_mode="r")
        if matrix.shape[0] != len(chunks):
            # Mismatch — treat as absent rather than serving bad results.
            return None
        return cls(slug=slug, chunks=chunks, matrix=np.asarray(matrix))

    def _embed_query(self, query: str) -> np.ndarray:
        vec = embed_batch([query], input_type="query")[0]
        n = float(np.linalg.norm(vec)) or 1.0
        return (vec / n).astype(np.float32)

    def search(self, query: str, k: int = 3) -> list[tuple[Chunk, float]]:
        q = self._embed_query(query)
        scores = self.matrix @ q  # cosine sim on normalized vectors
        k = max(1, min(k, len(self.chunks)))
        idx = np.argpartition(-scores, k - 1)[:k]
        idx = idx[np.argsort(-scores[idx])]
        return [(self.chunks[i], float(scores[i])) for i in idx]

    def format_snippets(self, hits: list[tuple[Chunk, float]], char_budget: int = 1500) -> str:
        parts: list[str] = []
        remaining = char_budget
        for chunk, _ in hits:
            header = chunk.citation()
            piece = f"{header} {chunk.text.strip()}"
            if len(piece) > remaining:
                piece = piece[: max(0, remaining)] + "…"
            parts.append(piece)
            remaining -= len(piece) + 2
            if remaining <= 0:
                break
        return "\n\n".join(parts) if parts else "(no matches)"
