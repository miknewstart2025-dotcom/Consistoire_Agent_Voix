"""Static smoke test for every use case.

No LiveKit connection — validates that each use case's YAML parses,
its briefing/memory files exist where declared, its agent name resolves
cleanly, and whichever optional resources it references (vector KB,
structured fact graph, escalation targets) are present on disk.
"""

from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(".env.local")

from graph import GraphIndex, has_graph  # noqa: E402
from kb import DocsIndex, has_docs  # noqa: E402
from providers import infer_llm_provider, resolve_llm_provider  # noqa: E402
from use_case import list_slugs, load, normalize_number  # noqa: E402

# Tools auto-dropped by ConfigurableAgent when the prerequisite is missing.
GRAPH_TOOLS = (
    "find_commerces", "find_mikvaot", "find_mohalim", "find_contact",
    "check_marriage_date", "lookup_fish", "lookup_product", "lookup_lock",
)


def check_slug(slug: str) -> bool:
    print(f"=== {slug} ===")
    try:
        uc = load(slug)
    except Exception as exc:  # noqa: BLE001
        print(f"  FAIL: load error — {exc}")
        return False

    print(f"  agent_name       : {uc.resolved_agent_name}")
    print(f"  language         : {uc.language}")
    llm_prov = resolve_llm_provider(uc)
    prov_src = "explicit" if uc.llm_provider else "inferred"
    print(f"  llm              : {llm_prov}/{uc.llm_model} ({prov_src})")
    print(f"  tts / stt        : {uc.tts_model} / {uc.stt_model}")
    print(f"  voice_id         : {uc.voice_id}")
    print(f"  wake_word        : {uc.wake_word!r}")
    print(f"  disconnect_word  : {uc.disconnect_word!r}")
    print(f"  briefing         : {len(uc.briefing)} chars")
    print(f"  memory           : {len(uc.memory)} chars")
    print(f"  access           : {uc.access}")
    if (uc.access or "public").lower() == "restricted":
        if not uc.authorized_numbers:
            print("  FAIL: access=restricted but authorized_numbers is empty")
            return False
        print(f"  authorized #'s   : {len(uc.authorized_numbers)} ({', '.join(uc.authorized_numbers)})")

    greeting_ok = bool(uc.greeting and uc.greeting.strip())
    prompt_ok = bool(uc.system_prompt and uc.system_prompt.strip())
    if not (greeting_ok and prompt_ok):
        print(f"  FAIL: missing greeting or system_prompt")
        return False

    # Tool availability mirrors ConfigurableAgent._keep() logic.
    tools: list[str] = []
    if uc.escalation_targets:
        tools.append(f"escalate_to_human → {list(uc.escalation_targets)}")
    if has_docs(slug):
        idx = DocsIndex.load(slug)
        n = len(idx.chunks) if idx else 0
        tools.append(f"lookup_knowledge_base ({n} chunks)")
    if has_graph(slug):
        g = GraphIndex.load(slug)
        tables_with_rows: list[tuple[str, int]] = []
        for table in (
            "commerces", "mikvaot", "marriage_forbidden_periods",
            "fish_species", "mohalim", "products",
            "locks_shabbat", "organigramme",
        ):
            try:
                n = g.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            except Exception:
                n = 0
            if n:
                tables_with_rows.append((table, n))
        tools.extend(f"graph.{t[0]}={t[1]}" for t in tables_with_rows)
        # Graph tools activate as a set when any table exists.
        if tables_with_rows:
            tools.append(f"graph-tools: {', '.join(GRAPH_TOOLS)}")
        g.close()

    if tools:
        print("  tools            :")
        for t in tools:
            print(f"    - {t}")
    else:
        print("  tools            : (none beyond defaults)")

    return True


def check_number_normalization() -> bool:
    print("=== number normalization ===")
    cases = [
        ("+33 6 12 34 56 78", "+33612345678"),
        ("tel:+33612345678;user=phone", "+33612345678"),
        ("+33612345678@sip.twilio.com", "+33612345678"),
        ("0033612345678", "0033612345678"),
        ("", ""),
        (None, ""),
    ]
    ok = True
    for raw, expected in cases:
        got = normalize_number(raw)
        mark = "ok" if got == expected else "FAIL"
        print(f"  {mark}: {raw!r} -> {got!r} (expected {expected!r})")
        ok = ok and got == expected
    return ok


def check_authorization_gate() -> bool:
    print("=== authorization gate ===")
    from use_case import UseCase
    public = UseCase(
        slug="t", name="t", description="", language="fr",
        voice_id="v", system_prompt="x", greeting="hi", access="public",
    )
    restricted = UseCase(
        slug="t", name="t", description="", language="fr",
        voice_id="v", system_prompt="x", greeting="hi", access="restricted",
        authorized_numbers=["+33612345678", "+44207946000"],
    )
    cases = [
        (public, "+33699999999", True, "public accepts any"),
        (public, None, True, "public accepts unknown"),
        (restricted, "+33612345678", True, "exact match"),
        (restricted, "+33 6 12 34 56 78", True, "formatted match"),
        (restricted, "tel:+44207946000;user=phone", True, "sip uri match"),
        (restricted, "+33699999999", False, "not in list"),
        (restricted, None, False, "restricted rejects unknown"),
    ]
    ok = True
    for uc, num, expected, label in cases:
        got = uc.is_caller_authorized(num)
        mark = "ok" if got == expected else "FAIL"
        print(f"  {mark}: {label}: {num!r} -> {got} (expected {expected})")
        ok = ok and got == expected
    return ok


def check_phrase_regexes() -> bool:
    print("=== wake / disconnect phrase regex ===")
    from use_case import UseCase
    uc = UseCase(
        slug="t", name="t", description="", language="en",
        voice_id="v", system_prompt="x", greeting="hi",
        wake_word="hey Gene", disconnect_word="bye Gene",
    )
    cases = [
        (uc.wake_regex, "Hey Gene, what's next?", True, "wake exact"),
        (uc.wake_regex, "HEY GENE! any updates", True, "wake caps + punct"),
        (uc.wake_regex, "hi there", False, "wake miss"),
        (uc.disconnect_regex, "bye Gene", True, "disc exact"),
        (uc.disconnect_regex, "OK, bye Gene.", True, "disc trailing punct"),
        (uc.disconnect_regex, "thanks, goodbye", False, "disc miss"),
    ]
    ok = True
    for regex, text, expected, label in cases:
        got = bool(regex and regex.search(text))
        mark = "ok" if got == expected else "FAIL"
        print(f"  {mark}: {label}: {text!r} -> {got} (expected {expected})")
        ok = ok and got == expected
    # Regex is None when phrase is absent
    off = UseCase(slug="t", name="t", description="", language="en",
                  voice_id="v", system_prompt="x", greeting="hi")
    if off.wake_regex is not None or off.disconnect_regex is not None:
        print("  FAIL: empty phrase should yield None regex")
        ok = False
    else:
        print("  ok: empty phrase -> None regex")
    return ok


def check_llm_provider_inference() -> bool:
    print("=== llm provider inference ===")
    cases = [
        ("claude-sonnet-4-6", "anthropic"),
        ("claude-opus-4-7", "anthropic"),
        ("claude-haiku-4-5-20251001", "anthropic"),
        ("gpt-4.1", "openai"),
        ("gpt-4o-mini", "openai"),
        ("o1-preview", "openai"),
        ("o3-mini", "openai"),
        ("chatgpt-4o-latest", "openai"),
        ("something-unknown", "anthropic"),  # default
    ]
    ok = True
    for model, expected in cases:
        got = infer_llm_provider(model)
        mark = "ok" if got == expected else "FAIL"
        print(f"  {mark}: {model!r} -> {got} (expected {expected})")
        ok = ok and got == expected
    return ok


def check_hebrew_detection() -> bool:
    """Test _detect_lang for the Hebrew-detection fixes.

    Covers three failure modes observed in call summaries:
    1. Deepgram romanises Hebrew speech → single-word "Ivrite." missed the old
       _MIN_WORDS=4 gate and returned None instead of 'he'.
    2. Garbled multi-word phonetic output ("Yverite,") also missed.
    3. Actual Hebrew Unicode from a user who typed their message directly.
    """
    print("=== Hebrew detection (_detect_lang) ===")
    from agent import _detect_lang

    cases = [
        # ---- Deepgram phonetic romanisation ----
        ("Ivrite.", "he", "single-word phonetic (Deepgram)"),
        ("ivrit", "he", "bare phonetic"),
        ("ivrite,", "he", "phonetic with comma"),
        ("Yverite,", None, "garbled Deepgram output — no signal, not misdetected as 'he'"),
        ("Ivrith.", "he", "alternate spelling"),
        ("Hebrew please", "he", "English keyword 'hebrew'"),
        ("hébreu s'il vous plaît", "he", "French keyword 'hébreu'"),
        # ---- Actual Hebrew Unicode (user typed) ----
        ("עברית בבקשה", "he", "Hebrew Unicode script"),
        ("שלום, מה שלומך?", "he", "Hebrew sentence"),
        # ---- Should NOT trigger Hebrew ----
        ("Bonjour", None, "French greeting — too short, not Hebrew"),
        ("hello how are you doing today", "en", "English sentence"),
        ("je voudrais un restaurant", None, "French — default lang, no switch needed"),
        ("A taller hall le", None, "garbled Deepgram — no signal, stays in current lang"),
        ("je voudrais un restaurant casher", None, "French text — no switch needed, French is default"),
    ]
    ok = True
    for text, expected, label in cases:
        got = _detect_lang(text)
        mark = "ok" if got == expected else "FAIL"
        print(f"  {mark}: {label!r}: {text!r} -> {got!r} (expected {expected!r})")
        ok = ok and (got == expected)
    return ok


def check_memory_trim() -> bool:
    """Test _trim_memory keeps the header and recent entries within budget."""
    print("=== memory trim (_trim_memory) ===")
    from summary import _trim_memory

    header = "# Memory\n\nThis is the header.\n"
    sep = "\n\n---\n\n"
    entry = lambda n: f"## Call {n}\n\nSome content for call {n}.\n"

    # Build a file with 5 entries
    entries = [entry(i) for i in range(1, 6)]
    full = header + sep + sep.join(entries)

    # Budget that fits 3 entries but not 5
    budget = len(header) + len(sep) + sum(len(sep) + len(e) for e in entries[-3:]) + 1

    trimmed = _trim_memory(full, budget)
    assert len(trimmed) <= budget, f"Trim failed: {len(trimmed)} > {budget}"

    # Header must be preserved
    assert trimmed.startswith(header), "Header lost after trim"

    # Most recent entry must be present
    assert "Call 5" in trimmed, "Most recent entry lost"

    # Oldest entries should be gone
    dropped = "Call 1" not in trimmed and "Call 2" not in trimmed
    if not dropped:
        print("  FAIL: old entries not dropped")
        return False

    # Single-entry file must never lose that entry even if it exceeds budget
    tiny_budget = 10
    single = header + sep + entry(1)
    result = _trim_memory(single, tiny_budget)
    assert entry(1) in result, "Single entry must not be dropped"

    print("  ok: trim keeps header + recent entries, drops oldest")
    return True


def main() -> int:
    slugs = list_slugs()
    if not slugs:
        print("no use cases found")
        return 1
    slugs_ok = all(check_slug(s) for s in slugs)
    print()
    parser_ok = check_number_normalization()
    print()
    auth_ok = check_authorization_gate()
    print()
    llm_ok = check_llm_provider_inference()
    print()
    phrase_ok = check_phrase_regexes()
    print()
    print()
    hebrew_ok = check_hebrew_detection()
    print()
    memory_ok = check_memory_trim()
    print()
    all_ok = slugs_ok and parser_ok and auth_ok and llm_ok and phrase_ok and hebrew_ok and memory_ok
    print("OK" if all_ok else "SOME FAILED")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
