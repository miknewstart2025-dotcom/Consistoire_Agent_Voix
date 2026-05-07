"""LLM provider factory.

Resolves the LiveKit LLM plugin from a use case's `llm_provider` +
`llm_model`. When `llm_provider` is empty the provider is inferred from
the model ID, so existing YAMLs keep working without edits.

STT / TTS remain single-provider for now; extend this module when that
changes.
"""

from __future__ import annotations

from livekit.plugins import anthropic, openai as lk_openai

from use_case import UseCase


def infer_llm_provider(model: str) -> str:
    m = (model or "").lower()
    if m.startswith("claude-"):
        return "anthropic"
    if m.startswith(("gpt-", "o1-", "o3-", "o4-", "chatgpt-")):
        return "openai"
    return "anthropic"


def resolve_llm_provider(uc: UseCase) -> str:
    return (uc.llm_provider or "").strip().lower() or infer_llm_provider(uc.llm_model)


def build_llm(uc: UseCase):
    provider = resolve_llm_provider(uc)
    if provider == "anthropic":
        # _strict_tool_schema=False keeps optional params optional; without
        # this Anthropic 400s past ~9 tools because of the 16-union cap.
        return anthropic.LLM(model=uc.llm_model, _strict_tool_schema=False)
    if provider == "openai":
        return lk_openai.LLM(model=uc.llm_model)
    raise ValueError(
        f"Unknown llm_provider {uc.llm_provider!r} for model {uc.llm_model!r}"
    )
