"""Write a markdown call summary on session shutdown.

Reads the agent's chat_ctx, runs a one-shot summarization against the
use case's own LLM (same provider + model that handled the conversation),
and saves the result to `summaries/<timestamp>_<slug>_<room>.md`. Skipped
when the conversation is too short to be worth summarizing.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from pathlib import Path

from providers import resolve_llm_provider
from use_case import UseCase, memory_path as use_case_memory_path

logger = logging.getLogger("laurent-dev-agent")

SUMMARIES_DIR = Path(__file__).parent / "summaries"
MIN_USER_TURNS = 1
MAX_SUMMARY_TOKENS = 1500
# Memory file trimming: keep at most this many characters in the accumulated
# memory file. When exceeded, the oldest entries (up to half the budget) are
# dropped so the most recent calls are always available in context.
MAX_MEMORY_CHARS = 40_000

SUMMARY_SYSTEM_PROMPT = """You summarize a voice-agent call transcript into a \
concise, audit-ready markdown report. Return ONLY the markdown body — no \
preamble, no trailing commentary, no wrapping code fences.

Follow this exact section order and heading hierarchy:

## Context
One short paragraph: what the caller seemed to want from this session, and \
how the conversation was framed.

## Key Topics
Bullet list of 3-7 topics covered. Each bullet is one sentence.

## Decisions
Bullet list of concrete decisions made during the call. If none, write \
"_No explicit decisions were made during this call._".

## Action Items
Bullet list in the form `- [ ] <action> — <owner if mentioned>`. If none, \
write "_No action items were identified._".

## Notable Quotes
Up to 3 short direct quotes from the user that capture intent or \
constraints. Use markdown blockquote syntax. Skip the section if nothing \
stands out.

## Open Questions
Bullet list of unresolved questions the agent or the user raised. If none, \
write "_No open questions remain._".

Rules:
- Stay faithful to the transcript. Do not invent content.
- Quote the user's language when the domain vocabulary is specific.
- Write in the same language as the transcript.
- Keep the total length under 400 words (excluding the transcript appendix \
  which the caller adds outside your output).
"""


def _safe_room_slug(room_name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", room_name).strip("-")[:60] or "room"


def _extract_transcript(chat_ctx) -> list[tuple[str, str]]:
    """Return ordered (role, text) pairs for user/assistant turns only."""
    turns: list[tuple[str, str]] = []
    for item in chat_ctx.items:
        role = getattr(item, "role", None)
        if role not in ("user", "assistant"):
            continue
        text = getattr(item, "text_content", None) or ""
        text = text.strip()
        if not text:
            continue
        turns.append((role, text))
    return turns


def _format_transcript_for_llm(turns: list[tuple[str, str]]) -> str:
    parts = []
    for role, text in turns:
        speaker = "User" if role == "user" else "Agent"
        parts.append(f"{speaker}: {text}")
    return "\n\n".join(parts)


def _format_transcript_appendix(turns: list[tuple[str, str]]) -> str:
    lines = ["<details>", "<summary>Full transcript</summary>", ""]
    for role, text in turns:
        speaker = "**User**" if role == "user" else "**Agent**"
        lines.append(f"{speaker}: {text}")
        lines.append("")
    lines.append("</details>")
    return "\n".join(lines)


async def _run_summary(provider: str, model: str, user_payload: str) -> str:
    """Dispatch one-shot summarization to the same provider the conversation
    used. Returns the summary body (stripped) or empty string on no-content."""
    if provider == "anthropic":
        from anthropic import AsyncAnthropic
        client = AsyncAnthropic()
        response = await client.messages.create(
            model=model,
            max_tokens=MAX_SUMMARY_TOKENS,
            system=SUMMARY_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_payload}],
        )
        return "".join(
            block.text for block in response.content
            if getattr(block, "type", None) == "text"
        ).strip()

    if provider == "openai":
        from openai import AsyncOpenAI
        client = AsyncOpenAI()
        # max_completion_tokens replaces the deprecated max_tokens on newer
        # OpenAI models (GPT-5, o-series). System role goes in the messages
        # list, unlike Anthropic which takes a dedicated `system` param.
        response = await client.chat.completions.create(
            model=model,
            max_completion_tokens=MAX_SUMMARY_TOKENS,
            messages=[
                {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                {"role": "user", "content": user_payload},
            ],
        )
        return (response.choices[0].message.content or "").strip()

    raise ValueError(f"Unknown provider for summary: {provider!r}")


async def write_summary(
    agent,  # ConfigurableAgent — typed loosely to avoid circular import
    start_time: datetime,
    room_name: str,
) -> None:
    """Generate and save a markdown summary. Safe to call on shutdown."""
    try:
        turns = _extract_transcript(agent.chat_ctx)
    except Exception as e:
        logger.exception("Summary: failed to extract transcript: %s", e)
        return

    user_turns = sum(1 for role, _ in turns if role == "user")
    if user_turns < MIN_USER_TURNS:
        logger.info("Summary skipped — only %d user turn(s)", user_turns)
        return

    end_time = datetime.now()
    duration_s = (end_time - start_time).total_seconds()
    uc = agent.use_case

    transcript_for_llm = _format_transcript_for_llm(turns)
    user_payload = (
        f"Use case: {uc.name} ({uc.slug})\n"
        f"Duration: {int(duration_s)}s, {user_turns} user turn(s)\n\n"
        f"Transcript:\n\n{transcript_for_llm}"
    )

    provider = resolve_llm_provider(uc)
    try:
        body = await _run_summary(provider, uc.llm_model, user_payload)
    except Exception as e:
        logger.exception("Summary: %s call failed: %s", provider, e)
        return

    if not body:
        logger.warning("Summary: empty body returned")
        return

    header = (
        f"# Call summary — {uc.name}\n\n"
        f"- **Use case:** `{uc.slug}`\n"
        f"- **Room:** `{room_name}`\n"
        f"- **Started:** {start_time.isoformat(timespec='seconds')}\n"
        f"- **Ended:** {end_time.isoformat(timespec='seconds')}\n"
        f"- **Duration:** {int(duration_s)} seconds\n"
        f"- **User turns:** {user_turns}\n"
        f"- **Summary model:** `{provider}/{uc.llm_model}`\n\n"
        "---\n\n"
    )
    appendix = "\n\n---\n\n## Transcript (appendix)\n\n" + _format_transcript_appendix(turns) + "\n"

    SUMMARIES_DIR.mkdir(exist_ok=True)
    filename = (
        f"{start_time:%Y%m%d-%H%M%S}_{uc.slug}_{_safe_room_slug(room_name)}.md"
    )
    path = SUMMARIES_DIR / filename
    path.write_text(header + body + appendix, encoding="utf-8")
    logger.info("Summary saved: %s", path)

    _append_to_memory(uc.slug, start_time, end_time, room_name, user_turns, body)


def _trim_memory(text: str, budget: int) -> str:
    """Drop the oldest `---`-delimited sections until text fits within budget.

    The file header (everything before the first `---` separator) is always
    preserved. At least one entry (the most recent) is always kept, even if
    it alone exceeds the budget.
    """
    if len(text) <= budget:
        return text
    sep = "\n\n---\n\n"
    parts = text.split(sep)
    if len(parts) <= 2:
        return text
    header = parts[0]
    entries = parts[1:]
    while len(entries) > 1 and len(header + sep + sep.join(entries)) > budget:
        entries.pop(0)
    return header + sep + sep.join(entries)


def _append_to_memory(
    slug: str,
    start_time: datetime,
    end_time: datetime,
    room_name: str,
    user_turns: int,
    body: str,
) -> None:
    """Append the summary body (no transcript) to use_cases/<slug>.memory.md
    so the next call's chat context carries accumulated knowledge from past
    sessions. Trims the oldest entries when the file exceeds MAX_MEMORY_CHARS."""
    try:
        path = use_case_memory_path(slug)
        entry = (
            f"\n\n---\n\n"
            f"## Call on {start_time:%Y-%m-%d %H:%M} "
            f"({int((end_time - start_time).total_seconds())}s, {user_turns} user turns)\n\n"
            f"_Room: `{room_name}`_\n\n"
            f"{body.strip()}\n"
        )
        header_if_new = (
            f"# Accumulated call memory — {slug}\n\n"
            "This file is machine-appended after every call. Each entry is a "
            "compact summary (no transcript) of a past session. The agent "
            "reads this as context on future calls so it can reference prior "
            "decisions, action items, and recurring themes without replaying "
            "raw dialog.\n"
        )
        if path.exists():
            existing = path.read_text(encoding="utf-8")
            updated = existing + entry
        else:
            updated = header_if_new + entry
        updated = _trim_memory(updated, MAX_MEMORY_CHARS)
        path.write_text(updated, encoding="utf-8")
        logger.info("Memory updated: %s (%d chars)", path, len(updated))
    except Exception as e:
        logger.exception("Summary: memory append failed: %s", e)
