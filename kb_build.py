"""Build the per-use-case knowledge base index.

Usage:
    python kb_build.py <slug>       # one use case
    python kb_build.py --all        # every use case with a docs/ folder

Requires VOYAGE_API_KEY in .env.local (already loaded by dotenv).
"""

import argparse
import sys

from dotenv import load_dotenv

load_dotenv(".env.local")

from kb import build_index, docs_dir, has_docs  # noqa: E402
from use_case import list_slugs  # noqa: E402


def _build_one(slug: str) -> bool:
    if not has_docs(slug):
        print(f"[{slug}] no docs/ folder or empty — skipping")
        return True
    print(f"[{slug}] indexing docs from {docs_dir(slug)}")
    try:
        n, idx = build_index(slug)
    except Exception as exc:  # surface any extractor/embedding failure
        print(f"[{slug}] FAILED: {exc}")
        return False
    print(f"[{slug}] wrote {n} chunks to {idx}")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="(Re)build docs knowledge base index.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("slug", nargs="?", help="Use case slug")
    group.add_argument("--all", action="store_true", help="Rebuild every use case that has docs/")
    args = parser.parse_args()

    slugs = list_slugs() if args.all else [args.slug]
    ok = all(_build_one(s) for s in slugs)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
