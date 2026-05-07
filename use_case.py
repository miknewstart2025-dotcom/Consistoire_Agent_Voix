"""Use case loader — reads YAML config + optional briefing + memory markdown.

Each use case lives in `use_cases/` as up to three sibling files:
    <slug>.yaml           — config (persona, voice, greeting, wake word, ...)
    <slug>.briefing.md    — curated reference content (static domain knowledge)
    <slug>.memory.md      — accumulated summaries from past calls (grows over time)

Both markdown files are injected into chat context as separate system
messages with their own preludes, so the model can distinguish durable
briefing from evolving call history.

A slug is the file stem (e.g. `tae`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

USE_CASES_DIR = Path(__file__).parent / "use_cases"
DEFAULT_SLUG = "tae"


@dataclass
class UseCase:
    slug: str
    name: str
    description: str
    language: str
    voice_id: str
    system_prompt: str
    greeting: str
    tts_model: str = "eleven_multilingual_v2"
    llm_model: str = "claude-sonnet-4-6"
    # LLM provider: "anthropic" | "openai". Empty = inferred from llm_model
    # (see providers.infer_llm_provider). Set explicitly when the model
    # naming collides (e.g. a fine-tuned alias).
    llm_provider: str = ""
    # Per-language voice IDs for dynamic TTS switching. Keys are BCP-47 language
    # codes (e.g. 'fr', 'en', 'he'). voice_id is always the fallback default.
    voices: dict = field(default_factory=dict)
    stt_model: str = "nova-3"
    stt_language: str = "fr"
    wake_word: str | None = None
    # Phrase the caller can say to make the agent play a short localized
    # farewell and hang up. Matched with the same tolerant regex as
    # `wake_word`. None disables the feature.
    disconnect_word: str | None = None
    # Short interjections (e.g. "Hmm.", "Alors…") spoken to bridge dead air
    # while the LLM/TTS pipeline produces a real reply. Empty = disabled.
    # The agent only speaks one if the response hasn't started after a
    # short grace period, so the filler doesn't collide with fast turns.
    turn_fillers: list[str] = field(default_factory=list)
    briefing_prelude: str = ""
    briefing: str = ""
    memory_prelude: str = ""
    memory: str = ""
    escalation_targets: dict = field(default_factory=dict)
    # LiveKit worker agent_name that hosts this use case. One worker per use
    # case — this is what the SIP dispatch rule targets. Defaults to the slug
    # so new use cases don't need extra config; override when the desired
    # agent name differs (e.g. 'consistoire-paris' → 'consistoire').
    agent_name: str = ""
    # Inbound PSTN access control. "public" = accept every caller;
    # "restricted" = only accept numbers in `authorized_numbers`. Normalized
    # to E.164 at load time; outbound + Zoom flows ignore this.
    access: str = "public"
    authorized_numbers: list[str] = field(default_factory=list)
    # Documentary: the inbound PSTN number this use case answers on. Routing
    # is enforced by a LiveKit dispatch rule (managed via `lk sip dispatch`),
    # not by this field — but recording it here lets the admin UI display the
    # binding alongside the use case.
    inbound_number: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def resolved_agent_name(self) -> str:
        return self.agent_name or self.slug

    def is_caller_authorized(self, number: str | None) -> bool:
        if (self.access or "public").lower() != "restricted":
            return True
        if not number:
            return False
        return normalize_number(number) in set(self.authorized_numbers)

    @property
    def wake_regex(self) -> re.Pattern[str] | None:
        """Build a tolerant regex for the configured wake word, or None."""
        return _tolerant_phrase_regex(self.wake_word)

    @property
    def disconnect_regex(self) -> re.Pattern[str] | None:
        return _tolerant_phrase_regex(self.disconnect_word)


def _tolerant_phrase_regex(phrase: str | None) -> re.Pattern[str] | None:
    """Tolerant word-boundary regex for short spoken phrases (wake /
    disconnect words). Tokens join with optional whitespace+punctuation,
    case-insensitive, and trailing punctuation is eaten so the phrase
    can be stripped from a longer utterance.
    """
    if not phrase:
        return None
    tokens = [re.escape(t) for t in phrase.split()]
    body = r"\s*[,!?:.]?\s*".join(tokens)
    return re.compile(rf"\b{body}\b[,.!?;:\s]*", re.IGNORECASE)


def normalize_number(s: str | None) -> str:
    """Canonicalize a phone string to compare against the YAML allow-list.

    Keeps a leading `+` and decimal digits, strips `tel:` prefix, SIP URI
    params, whitespace and any formatting. Accent/case irrelevant.
    """
    if not s:
        return ""
    t = str(s).strip().lower()
    if t.startswith("tel:"):
        t = t[4:]
    t = t.split(";", 1)[0].split("@", 1)[0]
    plus = t.startswith("+")
    digits = "".join(c for c in t if c.isdigit())
    return ("+" if plus else "") + digits


def _parse_authorized_numbers(value) -> list[str]:
    """Accept list or comma-separated string; return normalized E.164 list."""
    if value is None:
        return []
    if isinstance(value, str):
        items: list = value.split(",")
    elif isinstance(value, (list, tuple)):
        items = list(value)
    else:
        return []
    out: list[str] = []
    for it in items:
        n = normalize_number(str(it))
        if n:
            out.append(n)
    return out


def _config_path(slug: str) -> Path:
    return USE_CASES_DIR / f"{slug}.yaml"


def _briefing_path(slug: str) -> Path:
    return USE_CASES_DIR / f"{slug}.briefing.md"


def memory_path(slug: str) -> Path:
    """Public helper so the summary writer can append to the memory file."""
    return USE_CASES_DIR / f"{slug}.memory.md"


def load(slug: str | None = None) -> UseCase:
    slug = slug or DEFAULT_SLUG
    config_file = _config_path(slug)
    if not config_file.exists():
        raise FileNotFoundError(f"Use case not found: {config_file}")
    data = yaml.safe_load(config_file.read_text(encoding="utf-8")) or {}

    briefing_file = _briefing_path(slug)
    briefing = briefing_file.read_text(encoding="utf-8") if briefing_file.exists() else ""

    memory_file = memory_path(slug)
    memory = memory_file.read_text(encoding="utf-8") if memory_file.exists() else ""

    known = {
        "name", "description", "language", "voice_id", "system_prompt",
        "greeting", "tts_model", "llm_model", "llm_provider",
        "stt_model", "stt_language",
        "wake_word", "disconnect_word", "turn_fillers",
        "briefing_prelude", "memory_prelude", "escalation_targets",
        "agent_name", "access", "authorized_numbers", "inbound_number",
        "voices",
    }
    kwargs = {k: data[k] for k in known if k in data}
    if "access" in kwargs:
        kwargs["access"] = (str(kwargs["access"]).strip().lower() or "public")
    if "authorized_numbers" in kwargs:
        kwargs["authorized_numbers"] = _parse_authorized_numbers(kwargs["authorized_numbers"])
    extra = {k: v for k, v in data.items() if k not in known}
    return UseCase(slug=slug, briefing=briefing, memory=memory, extra=extra, **kwargs)


def save(uc: UseCase) -> None:
    USE_CASES_DIR.mkdir(exist_ok=True)
    payload = {
        "name": uc.name,
        "description": uc.description,
        "language": uc.language,
        "voice_id": uc.voice_id,
        "tts_model": uc.tts_model,
        "llm_provider": uc.llm_provider,
        "llm_model": uc.llm_model,
        "stt_model": uc.stt_model,
        "stt_language": uc.stt_language,
        "wake_word": uc.wake_word,
        "disconnect_word": uc.disconnect_word,
        "turn_fillers": uc.turn_fillers,
        "agent_name": uc.agent_name,
        "access": uc.access,
        "authorized_numbers": ", ".join(uc.authorized_numbers),
        "inbound_number": uc.inbound_number,
        "greeting": uc.greeting,
        "briefing_prelude": uc.briefing_prelude,
        "memory_prelude": uc.memory_prelude,
        "escalation_targets": uc.escalation_targets,
        "system_prompt": uc.system_prompt,
        **uc.extra,
    }
    _config_path(uc.slug).write_text(
        yaml.safe_dump(payload, allow_unicode=True, sort_keys=False, width=80),
        encoding="utf-8",
    )
    if uc.briefing:
        _briefing_path(uc.slug).write_text(uc.briefing, encoding="utf-8")


def list_slugs() -> list[str]:
    if not USE_CASES_DIR.exists():
        return []
    return sorted(p.stem for p in USE_CASES_DIR.glob("*.yaml"))


def delete(slug: str) -> None:
    for p in (_config_path(slug), _briefing_path(slug), memory_path(slug)):
        if p.exists():
            p.unlink()
