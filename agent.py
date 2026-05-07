import asyncio
import json
import logging
import os
import random
from datetime import datetime

from dotenv import load_dotenv
from collections.abc import AsyncIterable

from livekit import api, rtc
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli
from livekit.agents.llm import ChatContext, ChatMessage, StopResponse, function_tool
from livekit.agents.voice import AgentSession, Agent
from livekit.plugins import deepgram, elevenlabs, silero

from graph import GraphIndex
from kb import DocsIndex
from providers import build_llm, resolve_llm_provider
from summary import write_summary
from use_case import UseCase, load as load_use_case, normalize_number

# --------------------------------------------------------------------------- #
#  Language detection (STT output → BCP-47 code)                             #
# --------------------------------------------------------------------------- #

import re as _re

_HE_RE = _re.compile(r'[֐-׿יִ-ﭏ]')  # Hebrew Unicode blocks
_EN_WORDS = frozenset([
    'the', 'is', 'are', 'have', 'what', 'how', 'please', 'hello', 'thank',
    'can', 'would', 'could', 'want', 'need', 'speak', 'call', 'help',
    'information', 'question', 'want', 'looking', 'know', 'tell', 'about',
    'find', 'where', 'when', 'which', 'who', 'yes', 'no', 'okay', 'sure',
])
# Deepgram nova-3 in multi-language mode romanises Hebrew speech instead of
# outputting Hebrew Unicode. "עברית" is transcribed as "ivrit" / "ivrite" etc.
# Detect these forms explicitly — no min-word threshold needed because a single
# such keyword is an unambiguous language signal.
_HE_PHONETIC = frozenset([
    'ivrit', 'ivrite', 'ivrith', 'ivrity',
    'hebrew', 'hébreu', 'hebreux', 'hébreux',
])
_MIN_WORDS = 4


def _detect_lang(text: str) -> str | None:
    """Return 'he', 'en', or None.

    'fr' is never returned — French is the default language and needs no
    positive detection. Returning 'fr' for ambiguous text (e.g. Deepgram's
    garbled Hebrew output) would spuriously switch the TTS back to French
    mid-call while the caller is still speaking Hebrew.
    """
    if _HE_RE.search(text):
        return 'he'
    # Phonetic Hebrew from Deepgram STT — matches even single-word inputs.
    words_norm = {w.strip('.,!?;: ').lower() for w in text.split()}
    if words_norm & _HE_PHONETIC:
        return 'he'
    words = text.lower().split()
    if len(words) < _MIN_WORDS:
        return None
    en_hits = sum(1 for w in words if w.strip('.,!?;:') in _EN_WORDS)
    return 'en' if en_hits >= 2 else None


# Short localized message played to a caller whose number is not in the
# use case's `authorized_numbers` allow-list. Fallback is French.
DENIAL_MESSAGES = {
    "fr": "Désolé, ce numéro n'est pas autorisé à joindre ce service. Au revoir.",
    "en": "Sorry, this number is not authorized to call this service. Goodbye.",
    "es": "Lo siento, este número no está autorizado a llamar a este servicio. Adiós.",
    "de": "Entschuldigung, diese Nummer ist nicht berechtigt, diesen Dienst anzurufen. Auf Wiedersehen.",
    "it": "Spiacenti, questo numero non è autorizzato a chiamare questo servizio. Arrivederci.",
}

# Short localized farewell played when the caller says the configured
# disconnect word (e.g. "bye Gene"). Spoken, then the room is torn down.
FAREWELL_MESSAGES = {
    "fr": "Au revoir, à bientôt.",
    "en": "Goodbye, take care.",
    "es": "Hasta luego.",
    "de": "Auf Wiedersehen.",
    "it": "Arrivederci.",
}


async def _hangup_room(ctx: JobContext) -> None:
    """Tear down the room so every SIP leg hangs up cleanly."""
    try:
        lkapi = api.LiveKitAPI(
            url=os.environ["LIVEKIT_URL"],
            api_key=os.environ["LIVEKIT_API_KEY"],
            api_secret=os.environ["LIVEKIT_API_SECRET"],
        )
        try:
            await lkapi.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
        finally:
            await lkapi.aclose()
    except Exception:  # noqa: BLE001
        logger.exception("Failed to delete room %s", ctx.room.name)

load_dotenv(".env.local")
logger = logging.getLogger("laurent-dev-agent")

DEFAULT_USE_CASE = os.environ.get("DEFAULT_USE_CASE", "tae")

# One worker per use case: the worker's LiveKit agent_name is dictated by
# its DEFAULT_USE_CASE (read from <slug>.yaml). AGENT_NAME env override is
# still accepted for ad-hoc multi-worker experiments.
_default_uc = load_use_case(DEFAULT_USE_CASE)
AGENT_NAME = os.environ.get("AGENT_NAME") or _default_uc.resolved_agent_name


class ConfigurableAgent(Agent):
    def __init__(
        self,
        use_case: UseCase,
        *,
        ctx: JobContext,
        wake_word_required: bool = False,
    ):
        super().__init__(instructions=use_case.system_prompt)
        self.use_case = use_case
        self.ctx = ctx
        self.wake_word_required = wake_word_required and use_case.wake_regex is not None
        self._turn_filler_task: asyncio.Task | None = None
        logger.info(
            "Agent constructed: slug=%s wake_word_required=%s (input=%s, wake_regex=%s)",
            use_case.slug, self.wake_word_required, wake_word_required,
            bool(use_case.wake_regex),
        )
        # Pre-build one ElevenLabs TTS instance per configured language so
        # voice swaps are instant (no re-construction on the hot path).
        # voices values: bare string (voice_id) OR dict {voice_id, model}.
        self._current_lang: str = (use_case.language or "fr")[:2].lower()
        self._tts_by_lang: dict[str, elevenlabs.TTS] = {}
        if use_case.voices:
            for lang, cfg in use_case.voices.items():
                if isinstance(cfg, dict):
                    vid = cfg.get("voice_id", use_case.voice_id)
                    model = cfg.get("model", use_case.tts_model)
                else:
                    vid, model = str(cfg), use_case.tts_model
                self._tts_by_lang[lang] = elevenlabs.TTS(
                    voice_id=vid,
                    model=model,
                    voice_settings=elevenlabs.VoiceSettings(
                        stability=0.6,
                        similarity_boost=0.8,
                        style=0.0,
                        use_speaker_boost=False,
                    ),
                    auto_mode=True,
                )
                logger.info("TTS prêt: lang=%s voice=%s model=%s", lang, vid, model)
            logger.info("Multilingual TTS ready: %s", list(use_case.voices.keys()))

        self.docs_index = DocsIndex.load(use_case.slug)
        if self.docs_index is not None:
            logger.info(
                "Knowledge base loaded for %s (%d chunks)",
                use_case.slug, len(self.docs_index.chunks),
            )
        self.graph_index = GraphIndex.load(use_case.slug)
        if self.graph_index is not None:
            logger.info("Fact graph loaded for %s", use_case.slug)

        # Auto-drop tools the use case hasn't provisioned, so the LLM
        # never sees something it can't actually execute.
        def _keep(tool) -> bool:
            name = getattr(getattr(tool, "info", None), "name", None)
            if name == "escalate_to_human" and not use_case.escalation_targets:
                return False
            if name == "lookup_knowledge_base" and self.docs_index is None:
                return False
            if name in (
                "find_commerces", "find_mikvaot", "find_mohalim", "find_contact",
                "check_marriage_date", "lookup_fish", "lookup_product", "lookup_lock",
                "find_synagogues",
                "find_salles",
                "find_rabbin",
                "find_talmud_torah",
                "find_aumonerie",
                "find_ecole",
            ) and self.graph_index is None:
                return False
            return True

        self._tools = [t for t in self._tools if _keep(t)]

    # Localized fillers for slow tools (vector KB lookup). Graph tools are
    # fast enough (<10 ms SQLite) that no filler is needed.
    _FILLERS = {
        "fr": "Un instant, je regarde.",
        "en": "One moment, let me check.",
    }

    async def _say_filler(self) -> None:
        lang = (self.use_case.language or "fr").lower()
        phrase = self._FILLERS.get(lang, self._FILLERS["fr"])
        try:
            await self.session.say(phrase, allow_interruptions=True)
        except Exception:  # noqa: BLE001 — filler is best-effort
            pass

    # Grace period before speaking a turn filler. ~700 ms covers most
    # Sonnet TTFT + TTS first-chunk latencies; if the real reply is faster,
    # we skip the filler so it never collides with the response.
    _TURN_FILLER_DELAY_S = 0.7

    async def _deferred_turn_filler(self) -> None:
        """Speak a short interjection if the agent hasn't started replying."""
        try:
            await asyncio.sleep(self._TURN_FILLER_DELAY_S)
        except asyncio.CancelledError:
            return
        if self.session.current_speech is not None:
            return  # the real reply (or another filler) is already on the bus
        fillers = self.use_case.turn_fillers
        if not fillers:
            return
        try:
            self.session.say(random.choice(fillers), allow_interruptions=True)
        except Exception:  # noqa: BLE001 — filler is best-effort
            pass

    # Languages where we buffer the full LLM response before sending to TTS.
    # Streaming token-by-token degrades quality for RTL languages and any
    # language where the sentence tokenizer doesn't work well.
    _BUFFERED_LANGS = frozenset({"he"})

    async def tts_node(
        self,
        text: AsyncIterable[str],
        model_settings,
    ) -> AsyncIterable[rtc.AudioFrame]:
        """Override: route audio to the language-specific TTS when available.

        For Hebrew: accumulate the full response before synthesizing so the
        TTS receives complete sentences, which gives pronunciation quality
        matching the ElevenLabs demo.
        For other languages: stream normally for low latency.

        Also handles automatic Hebrew detection in the outgoing text: when
        Deepgram STT romanises Hebrew speech ("Ivrite" instead of "עברית"),
        _detect_lang misses the switch but Claude still responds in Hebrew
        script. We peek at the first ~30 chars of the response — just a few
        LLM tokens — and switch to the Hebrew TTS if Hebrew Unicode is found.
        """
        from livekit.agents import utils as _agent_utils

        lang = self._current_lang
        lang_tts = self._tts_by_lang.get(lang) if self._tts_by_lang else None

        if lang_tts is None:
            # No language-specific TTS configured — use session default.
            async for frame in Agent.default.tts_node(self, text, model_settings):
                yield frame
            return

        activity = self._get_activity_or_raise()
        conn_options = activity.session.conn_options.tts_conn_options

        # --- Hebrew auto-detection in outgoing text ---
        # When a Hebrew voice is configured but _current_lang is not yet "he",
        # peek at the first ~30 chars to detect Hebrew script. Cost: we wait
        # for a few extra tokens before committing to the streaming path for
        # non-Hebrew turns — negligible on a phone call.
        he_tts = self._tts_by_lang.get("he") if self._tts_by_lang else None
        if he_tts is not None and lang != "he":
            # Use manual __anext__() to avoid calling aclose() on break, which
            # would close the underlying text source and drop all remaining chunks.
            peeked: list[str] = []
            text_iter = text.__aiter__()
            while len("".join(peeked)) < 30:
                try:
                    chunk = await text_iter.__anext__()
                    peeked.append(chunk)
                except StopAsyncIteration:
                    break

            if _HE_RE.search("".join(peeked)):
                # Hebrew script in response: switch TTS, collect rest, synthesize.
                self._current_lang = "he"
                lang = "he"
                lang_tts = he_tts
                logger.info("tts_node: Hebrew script detected in response, switched to 'he'")
                async for chunk in text_iter:
                    peeked.append(chunk)
                full_text = "".join(peeked).strip()
                if full_text:
                    async for ev in lang_tts.synthesize(full_text):
                        yield ev.frame
                return

            # Not Hebrew: reassemble peeked chunks with the remainder.
            async def _rejoined_text() -> AsyncIterable[str]:
                for c in peeked:
                    yield c
                async for c in text_iter:
                    yield c

            text = _rejoined_text()

        logger.info("tts_node: lang=%s buffered=%s", lang, lang in self._BUFFERED_LANGS)

        if lang in self._BUFFERED_LANGS:
            # Accumulate full text then synthesize in one shot — required for
            # Hebrew to match direct-API quality (streaming splits words mid-glyph).
            chunks: list[str] = []
            async for chunk in text:
                chunks.append(chunk)
            full_text = "".join(chunks).strip()
            if not full_text:
                return
            async for ev in lang_tts.synthesize(full_text):
                yield ev.frame
        else:
            # Stream normally (French, English).
            async with lang_tts.stream(conn_options=conn_options) as stream:
                async def _forward() -> None:
                    async for chunk in text:
                        stream.push_text(chunk)
                    stream.end_input()

                forward_task = asyncio.create_task(_forward())
                try:
                    async for ev in stream:
                        yield ev.frame
                finally:
                    await _agent_utils.aio.cancel_and_wait(forward_task)

    async def on_user_turn_completed(
        self, turn_ctx: ChatContext, new_message: ChatMessage
    ) -> None:
        text = (new_message.text_content or "")[:80]
        logger.info(
            "on_user_turn_completed: wake_gate=%s text=%r",
            self.wake_word_required, text,
        )

        # Cancel any filler scheduled by the previous turn that hasn't
        # fired yet — the user has spoken again, so the gap is over.
        if self._turn_filler_task is not None and not self._turn_filler_task.done():
            self._turn_filler_task.cancel()
        self._turn_filler_task = None

        # Disconnect phrase runs BEFORE the wake gate so callers can end the
        # call in multi-party (wake-gated) sessions too.
        disconnect_re = self.use_case.disconnect_regex
        if disconnect_re is not None:
            full_text = new_message.text_content or ""
            if disconnect_re.search(full_text):
                logger.info("Disconnect phrase detected: %r", full_text[:80])
                asyncio.create_task(self._farewell_and_hangup())
                raise StopResponse()

        if self.wake_word_required:
            wake_re = self.use_case.wake_regex
            assert wake_re is not None  # guaranteed by __init__ gate
            text = new_message.text_content or ""
            if not wake_re.search(text):
                logger.info("Wake word absent, réponse ignorée: %r", text[:80])
                raise StopResponse()
            new_message.content = [wake_re.sub("", text, count=1).strip() or text]

        # Detect language — tts_node will pick the right TTS instance.
        if self._tts_by_lang:
            detected = _detect_lang(new_message.text_content or "")
            if detected and detected != self._current_lang and detected in self._tts_by_lang:
                self._current_lang = detected
                logger.info("Language detected: %s", detected)

        # Inject language instruction into this turn's context so Claude
        # responds in the caller's language and doesn't revert to French.
        _LANG_INSTRUCTION = {
            "en": "The caller is speaking English. Reply in English for this turn and all subsequent turns until the language changes.",
            "he": "המתקשר מדבר עברית. ענה בעברית בתור זה ובכל התורות הבאים עד שהשפה תשתנה.",
            "fr": "",  # default — no instruction needed
        }
        lang_instr = _LANG_INSTRUCTION.get(self._current_lang, "")
        if lang_instr:
            turn_ctx.add_message(role="system", content=lang_instr)
            logger.info("Language instruction injected: %s", self._current_lang)

        # Schedule a deferred filler — only fires if the LLM/TTS pipeline
        # hasn't started speaking by `_TURN_FILLER_DELAY_S`.
        if self.use_case.turn_fillers:
            self._turn_filler_task = asyncio.create_task(self._deferred_turn_filler())

    async def _farewell_and_hangup(self) -> None:
        if self._turn_filler_task is not None and not self._turn_filler_task.done():
            self._turn_filler_task.cancel()
        lang = (self.use_case.language or "fr").lower()
        message = FAREWELL_MESSAGES.get(lang, FAREWELL_MESSAGES["fr"])
        try:
            await self.session.say(message, allow_interruptions=False).wait_for_playout()
        except Exception:  # noqa: BLE001 — best-effort; hang up regardless
            logger.exception("Failed to play farewell")
        await _hangup_room(self.ctx)

    @function_tool()
    async def escalate_to_human(self, target: str, reason: str) -> str:
        """Conference a human teammate into the live call via outbound SIP.

        Args:
            target: key from the use case's `escalation_targets` YAML map
                (e.g. 'supervisor', 'on_call'). Exact match required.
            reason: one-sentence justification, logged and used as the
                spoken handoff announcement to the caller.
        """
        targets = self.use_case.escalation_targets or {}
        number = targets.get(target)
        if not number:
            available = ", ".join(sorted(targets)) or "none configured"
            return f"Unknown escalation target '{target}'. Available: {available}."

        trunk_id = os.environ.get("ESCALATION_OUTBOUND_TRUNK_ID")
        if not trunk_id:
            logger.error("ESCALATION_OUTBOUND_TRUNK_ID not set; cannot escalate.")
            return "Escalation is not configured on this deployment."

        # The tool owns the handoff narration — kill any deferred turn filler
        # that's still pending so the caller doesn't hear "Un instant…" then
        # "Je vous mets en relation… un instant" back-to-back.
        if self._turn_filler_task is not None and not self._turn_filler_task.done():
            self._turn_filler_task.cancel()
            self._turn_filler_task = None

        await self.session.say(
            f"Je vous mets en relation. {reason} Merci de patienter un instant.",
            allow_interruptions=False,
        ).wait_for_playout()

        lkapi = api.LiveKitAPI(
            url=os.environ["LIVEKIT_URL"],
            api_key=os.environ["LIVEKIT_API_KEY"],
            api_secret=os.environ["LIVEKIT_API_SECRET"],
        )
        try:
            await lkapi.sip.create_sip_participant(
                api.CreateSIPParticipantRequest(
                    sip_trunk_id=trunk_id,
                    sip_call_to=number,
                    room_name=self.ctx.room.name,
                    participant_identity=f"escalation-{target}",
                    participant_name=f"Escalation: {target}",
                    play_dialtone=False,
                    wait_until_answered=True,
                    krisp_enabled=True,
                )
            )
            # Briefing played once the operator has picked up — both the
            # operator and the caller hear it, which is fine because the
            # caller already knows they're being transferred.
            await self.session.say(
                "Nous vous connectons avec notre fidèle qui a besoin de plus d'information.",
                allow_interruptions=False,
            ).wait_for_playout()
        except Exception as exc:  # noqa: BLE001 — surface any SIP failure to the LLM
            logger.exception("Escalation dial to %s (%s) failed", target, number)
            return f"Could not reach {target}: {exc}"
        finally:
            await lkapi.aclose()

        logger.info(
            "Escalation: %s (%s) bridged into %s — reason: %s",
            target, number, self.ctx.room.name, reason,
        )
        return f"{target} is now on the line."

    @function_tool()
    async def lookup_knowledge_base(self, query: str, k: int = 3) -> str:
        """Search this use case's reference documents.

        Use this when the caller asks a specific factual question whose
        answer you were not given in your briefing — product details,
        dates in a calendar, procedural minutiae, quotes from a policy.

        Args:
            query: the question, rephrased as a short search query in
                the document's original language.
            k: how many snippets to retrieve (1-5; default 3).

        Returns:
            Top-k snippets, each prefixed with a [source:locator]
            citation you should paraphrase aloud.
        """
        if self.docs_index is None:
            return "No knowledge base is configured for this use case."
        # Fire-and-forget filler so the caller hears something during the
        # ~300 ms Voyage query embedding + the LLM's second turn. The audio
        # is queued on the session bus and plays before the real reply.
        asyncio.create_task(self._say_filler())
        k = max(1, min(int(k or 3), 5))
        hits = await asyncio.to_thread(self.docs_index.search, query, k)
        logger.info(
            "KB lookup (%s): %r -> %s",
            self.use_case.slug, query[:80],
            [(h[0].source, h[0].locator, round(h[1], 3)) for h in hits],
        )
        return self.docs_index.format_snippets(hits)

    @function_tool()
    async def find_commerces(
        self,
        type_: str = "",
        arrondissement: int = 0,
        code_postal: str = "",
        ville: str = "",
        nom_like: str = "",
        limit: int = 10,
    ) -> str:
        """Exact lookup in the kosher-merchants directory.

        Prefer this over `lookup_knowledge_base` when the caller asks
        for a merchant by category, neighborhood, or name — it returns
        authoritative rows (address, phone) rather than fuzzy snippets.

        Leave a parameter unset (empty string / 0) when it does not apply;
        this keeps the tool schema under Anthropic's 16-union-param limit.

        Args:
            type_: Merchant category in French, e.g. 'boucherie',
                'restaurant', 'boulangerie', 'traiteur', 'épicerie'.
                Partial match (case-insensitive).
            arrondissement: Paris arrondissement number (1-20; 0 = unset).
                Matches both 750xx and 751xx postal codes.
            code_postal: Exact 5-digit postal code (use for suburbs,
                e.g. '93300'). Don't pass together with arrondissement.
            ville: Commune name substring (case-insensitive).
            nom_like: Substring of the merchant's name.
            limit: Max rows to return (default 10, cap 20).
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        limit = max(1, min(int(limit or 10), 20))
        rows = await asyncio.to_thread(
            self.graph_index.find_commerces,
            type_=type_ or None,
            arrondissement=arrondissement or None,
            code_postal=code_postal or None,
            ville=ville or None,
            nom_like=nom_like or None,
            limit=limit,
        )
        logger.info(
            "find_commerces (%s) type=%r arr=%r cp=%r ville=%r nom=%r -> %d rows",
            self.use_case.slug, type_, arrondissement, code_postal, ville, nom_like, len(rows),
        )
        return self.graph_index.format_rows(rows)

    @function_tool()
    async def find_mikvaot(
        self,
        arrondissement: int = 0,
        code_postal: str = "",
        ville: str = "",
        usage: str = "",
        limit: int = 10,
    ) -> str:
        """Exact lookup in the mikvaot (ritual baths) directory.

        Use this when the caller asks where to find a mikvé, or which
        mikvé serves a given arrondissement/commune, or which mikvé
        accepts men / women / vaisselle (utensil immersion).

        Args:
            arrondissement: Paris arrondissement number (1-20; 0 = unset).
            code_postal: Exact 5-digit postal code (for suburbs).
            ville: Commune name substring (case-insensitive).
            usage: 'femmes', 'hommes', or 'vaisselle'. Partial match.
            limit: Max rows to return (default 10, cap 20).
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        limit = max(1, min(int(limit or 10), 20))
        rows = await asyncio.to_thread(
            self.graph_index.find_mikvaot,
            arrondissement=arrondissement or None,
            code_postal=code_postal or None,
            ville=ville or None,
            usage=usage or None,
            limit=limit,
        )
        logger.info(
            "find_mikvaot (%s) arr=%r cp=%r ville=%r usage=%r -> %d rows",
            self.use_case.slug, arrondissement, code_postal, ville, usage, len(rows),
        )
        return self.graph_index.format_rows(rows)

    @function_tool()
    async def check_marriage_date(
        self,
        iso_date: str,
        rite: str = "",
    ) -> str:
        """Check whether a religious marriage can be celebrated on a given date.

        Use this whenever the caller asks about a specific wedding date.
        Covers Hebrew years 5786..5790 (≈ Sept 2025 — Sept 2030). Returns
        a verdict (OUI / NON) with every applicable reason cited: Shabbat,
        festivals, fast days, Pessah, Chavouot, Omer (rite-dependent,
        including the Lag Baomer exception for Ashkenaz), and the Three
        Weeks.

        Args:
            iso_date: Target date in ISO format 'YYYY-MM-DD'. Convert the
                caller's natural-language date (e.g. '20 mai 2026') to ISO
                before calling. If the year is ambiguous, ask the caller.
            rite: Groom's rite — 'sefarade' or 'achkenaze'. Optional; when
                omitted, Omer periods of BOTH rites are surfaced so you can
                follow up. The document specifies: the groom's rite governs.
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        result = await asyncio.to_thread(
            self.graph_index.check_marriage_date, iso_date, rite or None,
        )
        logger.info(
            "check_marriage_date (%s) date=%s rite=%r -> %s",
            self.use_case.slug, iso_date, rite, result.split('\n', 1)[0],
        )
        return result

    @function_tool()
    async def lookup_fish(self, name: str) -> str:
        """Check whether a fish species is on the Consistoire's authorized list.

        Use this the moment a caller names a fish. Matching is
        accent-insensitive and covers known aliases (Cabillaud/Cabilleau,
        Mulet/Muge, Sar doré/Sargue, etc.). The tool also flags
        explicitly forbidden look-alikes (Turbot, Saumonette, Carpe à
        cuir, Loup de mer, Filet).

        When the species is not in the list at all, the tool returns a
        prudent "pas dans la liste" — do NOT paraphrase that as
        "interdit"; many obscure species are simply not enumerated, and
        the caller should consult a rabbin.

        Args:
            name: The fish name as the caller pronounced it (any
                casing, accents optional).
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        result = await asyncio.to_thread(self.graph_index.lookup_fish, name)
        logger.info(
            "lookup_fish (%s) name=%r -> %s",
            self.use_case.slug, name, result.split('.', 1)[0],
        )
        return result

    @function_tool()
    async def find_mohalim(
        self,
        region: str = "",
        nom_like: str = "",
        limit: int = 20,
    ) -> str:
        """Look up a mohel (circumcisor) from the AFM registry.

        The registry is national but small. Each mohel is tagged with
        one or more canonical regions. Use the region that matches the
        caller's location; when uncertain, omit it and list everyone.

        Args:
            region: Canonical region tag. Valid values:
                'IDF' (Paris + Île-de-France, the default for most callers),
                'PACA' (Provence-Alpes-Côte d'Azur: Marseille, Nice, etc.),
                'Bas-Rhin' (Strasbourg / Alsace),
                'Aquitaine' (Bordeaux / Sud-Ouest),
                'Rhône-Alpes' (Lyon / Grenoble — note the hyphen).
                Map the caller's city to the matching region yourself.
            nom_like: Substring of the mohel's family name (accent-
                and case-insensitive).
            limit: Max results (default 20, cap 50).
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        limit = max(1, min(int(limit or 20), 50))
        rows = await asyncio.to_thread(
            self.graph_index.find_mohalim,
            region=region or None, nom_like=nom_like or None, limit=limit,
        )
        logger.info(
            "find_mohalim (%s) region=%r nom=%r -> %d rows",
            self.use_case.slug, region, nom_like, len(rows),
        )
        return self.graph_index.format_rows(rows)

    @function_tool()
    async def lookup_product(
        self,
        brand: str = "",
        product_name: str = "",
        category: str = "",
        tag: str = "",
        limit: int = 10,
    ) -> str:
        """Look up a product in the Beth Din ~3000-entry catalog.

        Use this the moment a caller names a grocery product. Pass as
        many parameters as you have; at least one is required. Matching
        is accent- and case-insensitive.

        Returns up to `limit` matches, each tagged [AUTORISÉ], [TOLÉRÉ],
        or [INTERDIT] with the product's conditions, tags, and category.

        If nothing matches, the tool returns a prudent "absence ≠
        interdiction" message. Do NOT paraphrase that as "interdit" to
        the caller — many products are simply not certified (different
        from forbidden). Advise them to verify with the ACIP.

        Args:
            brand: Brand name substring (e.g. 'Blédina', 'Boursin',
                'Modilac'). Case/accent-insensitive.
            product_name: Product name, variant, or flavor substring
                (e.g. 'blédilait', 'ail fines herbes', 'bio 2').
            category: Category breadcrumb substring ('BÉBÉ', 'BOISSONS',
                'FRAIS > Fromage', 'GLACES', 'CHOCOLAT'). Useful when
                the caller describes the kind of product rather than
                the brand.
            tag: Filter by a single tag code: 'L' (laitier), 'B' (bio),
                'SG' (sans gluten), 'SL' (sans lactose), 'N' (parvé /
                non-laitier).
            limit: Max results (default 10, cap 20).
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        limit = max(1, min(int(limit or 10), 20))
        result = await asyncio.to_thread(
            self.graph_index.lookup_product,
            brand=brand or None, product_name=product_name or None,
            category=category or None, tag=tag or None, limit=limit,
        )
        logger.info(
            "lookup_product (%s) brand=%r name=%r cat=%r tag=%r -> %s",
            self.use_case.slug, brand, product_name, category, tag,
            result.split('\n', 1)[0][:120],
        )
        return result

    @function_tool()
    async def lookup_lock(
        self,
        reference: str = "",
        company: str = "",
        limit: int = 10,
    ) -> str:
        """Check whether a mechatronic lock is certified for Shabbat use
        by the Beth Din de Paris.

        Use this when a caller asks about any electric, electronic, or
        mechatronic lock — only the models on this list are approved
        for use on Shabbat and Jewish holidays. Any other system (card
        readers, biometrics, timers, electromagnets) is not conforming
        unless it is one of these references.

        When no match is found, the tool returns an explicit non-
        conforming verdict (not a "pas dans la liste") — for locks,
        absence from the list means the system is not approved.

        Args:
            reference: Model code substring (e.g. 'KEL 404', 'TCP 25',
                'DG2PM'). Case-insensitive.
            company: Manufacturer substring ('ABLOY', 'TESA', 'OPERA',
                'VALENTE', 'GUIDOTTI').
            limit: Max results (default 10, cap 20).
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        limit = max(1, min(int(limit or 10), 20))
        result = await asyncio.to_thread(
            self.graph_index.lookup_lock,
            reference=reference or None, company=company or None, limit=limit,
        )
        logger.info(
            "lookup_lock (%s) ref=%r company=%r -> %s",
            self.use_case.slug, reference, company, result.split('\n', 1)[0][:120],
        )
        return result

    @function_tool()
    async def find_rabbin(
        self,
        nom_like: str = "",
        fonction: str = "",
        ville: str = "",
        limit: int = 10,
    ) -> str:
        """Look up a rabbi or religious official in the Consistoire registry.

        Use this when the caller asks for a specific rabbi by name,
        by function (Grand Rabbin, Délégué, Dayan…) or by city.

        Args:
            nom_like: Family or first name substring.
            fonction: Function/title substring (e.g. 'Grand Rabbin', 'Dayan').
            ville: City substring.
            limit: Max results (default 10).
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        rows = await asyncio.to_thread(
            self.graph_index.find_rabbin,
            nom_like=nom_like or None, fonction=fonction or None,
            ville=ville or None, limit=max(1, min(int(limit or 10), 20)),
        )
        logger.info("find_rabbin (%s) nom=%r fn=%r -> %d rows", self.use_case.slug, nom_like, fonction, len(rows))
        return self.graph_index.format_rows(rows)

    @function_tool()
    async def find_talmud_torah(
        self,
        arrondissement: int = 0,
        code_postal: str = "",
        ville: str = "",
        limit: int = 10,
    ) -> str:
        """Find a Talmud Torah centre by location.

        Use this when the caller asks about Jewish education, Bar/Bat
        Mitsva preparation, or Talmud Torah classes for children.

        Args:
            arrondissement: Paris arrondissement (1-20; 0 = unset).
            code_postal: Exact 5-digit postal code.
            ville: Commune name substring.
            limit: Max results (default 10).
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        rows = await asyncio.to_thread(
            self.graph_index.find_talmud_torah,
            arrondissement=arrondissement or None,
            code_postal=code_postal or None,
            ville=ville or None,
            limit=max(1, min(int(limit or 10), 20)),
        )
        logger.info("find_talmud_torah (%s) arr=%r ville=%r -> %d rows", self.use_case.slug, arrondissement, ville, len(rows))
        return self.graph_index.format_rows(rows)

    @function_tool()
    async def find_aumonerie(
        self,
        type_: str = "",
        ville: str = "",
        limit: int = 10,
    ) -> str:
        """Find a Jewish chaplaincy (aumônerie) by type or location.

        Use this when the caller asks about chaplaincy services in
        hospitals, prisons, the army, or schools.

        Args:
            type_: Type substring: 'prison', 'hopitaux', 'armee', 'defense'.
            ville: City substring.
            limit: Max results (default 10).
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        rows = await asyncio.to_thread(
            self.graph_index.find_aumonerie,
            type_=type_ or None, ville=ville or None,
            limit=max(1, min(int(limit or 10), 20)),
        )
        logger.info("find_aumonerie (%s) type=%r ville=%r -> %d rows", self.use_case.slug, type_, ville, len(rows))
        return self.graph_index.format_rows(rows)

    @function_tool()
    async def find_ecole(
        self,
        arrondissement: int = 0,
        code_postal: str = "",
        ville: str = "",
        nom_like: str = "",
        limit: int = 10,
    ) -> str:
        """Find a Jewish school or nursery (école, crèche) by location or name.

        Use this when the caller asks about Jewish schooling options,
        nurseries, or a specific school by name.

        Args:
            arrondissement: Paris arrondissement (1-20; 0 = unset).
            code_postal: Exact 5-digit postal code.
            ville: Commune name substring.
            nom_like: School name substring.
            limit: Max results (default 10).
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        rows = await asyncio.to_thread(
            self.graph_index.find_ecole,
            arrondissement=arrondissement or None,
            code_postal=code_postal or None,
            ville=ville or None,
            nom_like=nom_like or None,
            limit=max(1, min(int(limit or 10), 20)),
        )
        logger.info("find_ecole (%s) arr=%r ville=%r -> %d rows", self.use_case.slug, arrondissement, ville, len(rows))
        return self.graph_index.format_rows(rows)

    @function_tool()
    async def find_salles(
        self,
        arrondissement: int = 0,
        code_postal: str = "",
        ville: str = "",
        capacite_min: int = 0,
        limit: int = 10,
    ) -> str:
        """Find community halls (salles communautaires) available for events.

        Use this when the caller asks where to rent a hall for a bar
        mitsva, wedding reception, or any community event.

        Args:
            arrondissement: Paris arrondissement (1-20; 0 = unset).
            code_postal: Exact 5-digit postal code.
            ville: Commune name substring (case-insensitive).
            capacite_min: Minimum number of seats required (0 = no filter).
            limit: Max rows to return (default 10, cap 20).
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        limit = max(1, min(int(limit or 10), 20))
        rows = await asyncio.to_thread(
            self.graph_index.find_salles,
            arrondissement=arrondissement or None,
            code_postal=code_postal or None,
            ville=ville or None,
            capacite_min=capacite_min or None,
            limit=limit,
        )
        logger.info(
            "find_salles (%s) arr=%r cp=%r ville=%r cap_min=%r -> %d rows",
            self.use_case.slug, arrondissement, code_postal, ville, capacite_min, len(rows),
        )
        return self.graph_index.format_rows(rows)

    @function_tool()
    async def find_synagogues(
        self,
        arrondissement: int = 0,
        code_postal: str = "",
        ville: str = "",
        nom_like: str = "",
        limit: int = 10,
    ) -> str:
        """Find synagogues and Jewish communities by location or name.

        Use this when the caller asks where to find a synagogue, which
        community serves a given area, or asks for the rabbi / officiant
        of a specific community.

        Args:
            arrondissement: Paris arrondissement number (1-20; 0 = unset).
            code_postal: Exact 5-digit postal code (for suburbs).
            ville: Commune name substring (case-insensitive).
            nom_like: Substring of the community name.
            limit: Max rows to return (default 10, cap 20).
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        limit = max(1, min(int(limit or 10), 20))
        rows = await asyncio.to_thread(
            self.graph_index.find_synagogues,
            arrondissement=arrondissement or None,
            code_postal=code_postal or None,
            ville=ville or None,
            nom_like=nom_like or None,
            limit=limit,
        )
        logger.info(
            "find_synagogues (%s) arr=%r cp=%r ville=%r nom=%r -> %d rows",
            self.use_case.slug, arrondissement, code_postal, ville, nom_like, len(rows),
        )
        return self.graph_index.format_rows(rows)

    @function_tool()
    async def find_contact(
        self,
        service: str = "",
        role: str = "",
        person_like: str = "",
        limit: int = 10,
    ) -> str:
        """Consistoire org-chart lookup — who runs a given service,
        how to reach them by phone or email.

        Use this when the caller asks to be transferred to a service
        ("je voudrais parler au service mariages", "qui s'occupe de la
        Hevra Kadicha", "directeur général"), or asks how to reach a
        named person.

        Matching is a case-insensitive substring on all three fields
        so partial inputs work ("marriage", "hevra", "direction").

        Args:
            service: Service or department substring (e.g. 'Mariages',
                'Hevra Kadicha', 'Cacherout', 'Finances', 'Sécurité',
                'Ressources Humaines', 'Services Educatifs').
            role: Role / title substring (e.g. 'Directeur', 'Président',
                'Rabbin', 'Responsable').
            person_like: Family name substring.
            limit: Max results (default 10, cap 20).
        """
        if self.graph_index is None:
            return "No fact graph is configured for this use case."
        limit = max(1, min(int(limit or 10), 20))
        rows = await asyncio.to_thread(
            self.graph_index.find_contact,
            service=service or None, role=role or None,
            person_like=person_like or None, limit=limit,
        )
        logger.info(
            "find_contact (%s) service=%r role=%r person=%r -> %d rows",
            self.use_case.slug, service, role, person_like, len(rows),
        )
        return self.graph_index.format_rows(rows)


def build_session(use_case: UseCase) -> AgentSession:
    return AgentSession(
        vad=silero.VAD.load(min_silence_duration=0.3, activation_threshold=0.45),
        stt=deepgram.STT(
            model=use_case.stt_model,
            language=use_case.stt_language,
            endpointing_ms=250,
        ),
        # Provider resolved from use_case.llm_provider, with inference from
        # llm_model when not set. See providers.build_llm for the Anthropic-
        # specific _strict_tool_schema=False workaround (16-union-params cap).
        llm=build_llm(use_case),
        # Voice settings tuned for turbo_v2_5: higher stability suppresses the
        # mumbling we heard on multilingual_v2, speaker_boost OFF avoids the
        # choppy/glitch DSP layer (noticeable on phone audio), and auto_mode
        # lets ElevenLabs pick chunk lengths so streaming is smoother.
        tts=elevenlabs.TTS(
            voice_id=use_case.voice_id,
            model=use_case.tts_model,
            voice_settings=elevenlabs.VoiceSettings(
                stability=0.6,
                similarity_boost=0.8,
                style=0.0,
                use_speaker_boost=False,
            ),
            auto_mode=True,
        ),
    )


async def inject_briefing(agent: ConfigurableAgent) -> None:
    uc = agent.use_case
    if not uc.briefing and not uc.memory:
        return
    chat_ctx = agent.chat_ctx.copy()
    if uc.briefing:
        prelude = uc.briefing_prelude or "Contexte factuel actualisé pour cette conversation:"
        chat_ctx.add_message(role="system", content=f"{prelude}\n\n{uc.briefing}")
        logger.info("Briefing chargé (%d caractères)", len(uc.briefing))
    if uc.memory:
        memory_prelude = uc.memory_prelude or (
            "Summaries of past calls for this use case, accumulated over time. "
            "Reference them when the user asks about prior sessions, decisions, "
            "or recurring themes. Do not read them aloud verbatim."
        )
        chat_ctx.add_message(role="system", content=f"{memory_prelude}\n\n{uc.memory}")
        logger.info("Mémoire chargée (%d caractères)", len(uc.memory))
    await agent.update_chat_ctx(chat_ctx)


async def _inbound_caller_number(ctx: JobContext, timeout: float = 3.0) -> str | None:
    """Poll the room for a SIP participant and return its caller number.

    LiveKit populates `sip.phoneNumber` on the inbound SIP participant's
    attributes as soon as the leg is set up. We give it up to `timeout`
    seconds to appear, since the participant can join milliseconds after
    the agent's entrypoint fires.
    """
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        for p in ctx.room.remote_participants.values():
            n = (p.attributes or {}).get("sip.phoneNumber")
            if n:
                return n
        await asyncio.sleep(0.1)
    return None


def _mask_number(n: str | None) -> str:
    if not n:
        return "<unknown>"
    return "***" + n[-3:] if len(n) >= 3 else "***"


async def _deny_and_hangup(
    ctx: JobContext, session: AgentSession, use_case: UseCase, caller: str | None
) -> None:
    lang = (use_case.language or "fr").lower()
    message = DENIAL_MESSAGES.get(lang, DENIAL_MESSAGES["fr"])
    logger.warning(
        "Access denied: slug=%s caller=%s — playing denial message and hanging up",
        use_case.slug, _mask_number(caller),
    )
    try:
        await session.say(message, allow_interruptions=False).wait_for_playout()
    except Exception:  # noqa: BLE001 — best-effort; hang up regardless
        logger.exception("Failed to play denial message")
    await _hangup_room(ctx)


async def run_inbound(ctx: JobContext, session: AgentSession, agent: ConfigurableAgent) -> None:
    """Inbound PSTN / web caller — greet immediately, then load briefing.

    Short pre-greeting sleep (600 ms) so the SIP leg's jitter buffer and
    WebRTC media path finish warming before TTS starts — otherwise the
    first word of the greeting gets clipped or mangled on the PSTN side.
    """
    logger.info("Flux inbound: attente warmup puis greeting")
    await asyncio.sleep(0.6)

    if (agent.use_case.access or "public").lower() == "restricted":
        caller = await _inbound_caller_number(ctx)
        if not agent.use_case.is_caller_authorized(caller):
            await _deny_and_hangup(ctx, session, agent.use_case, caller)
            return
        logger.info(
            "Access granted: slug=%s caller=%s",
            agent.use_case.slug, _mask_number(caller),
        )

    greeting = session.say(agent.use_case.greeting, allow_interruptions=False)
    await greeting.wait_for_playout()
    await inject_briefing(agent)


async def run_zoom(ctx: JobContext, session: AgentSession, agent: ConfigurableAgent) -> None:
    """Outbound Zoom meeting — wait for the SIP bridge to finish DTMF and join
    the meeting before greeting, otherwise the greeting is lost to the IVR."""
    logger.info("Flux Zoom: attente de la connexion au meeting")
    participant = await ctx.wait_for_participant(identity="zoom-bridge")

    for _ in range(60):  # up to 30s
        if participant.attributes.get("sip.callStatus") == "active":
            logger.info("Call active, tampon 3s pour l'annonce Zoom")
            break
        await asyncio.sleep(0.5)
    else:
        logger.warning("sip.callStatus n'est jamais passé à 'active'")
    await asyncio.sleep(3)

    greeting = session.say(agent.use_case.greeting, allow_interruptions=False)
    await greeting.wait_for_playout()
    await inject_briefing(agent)


async def run_outbound(ctx: JobContext, session: AgentSession, agent: ConfigurableAgent) -> None:
    """Outbound PSTN call to a person — wait for the callee to actually pick
    up (sip.callStatus='active') before greeting, otherwise the greeting
    plays into ringing / voicemail prompt."""
    logger.info("Flux outbound: attente de la décroche")
    participant = await ctx.wait_for_participant(identity="callee")

    for _ in range(120):  # up to 60s of ringing
        if participant.attributes.get("sip.callStatus") == "active":
            logger.info("Appel décroché, greeting imminent")
            break
        await asyncio.sleep(0.5)
    else:
        logger.warning("sip.callStatus n'est jamais passé à 'active' — pas de décroche?")

    greeting = session.say(agent.use_case.greeting, allow_interruptions=False)
    await greeting.wait_for_playout()
    await inject_briefing(agent)


async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    try:
        job_meta = json.loads(ctx.job.metadata or "{}")
    except json.JSONDecodeError:
        job_meta = {}

    use_case_slug = job_meta.get("use_case") or DEFAULT_USE_CASE
    try:
        use_case = load_use_case(use_case_slug)
    except FileNotFoundError:
        logger.error("Use case introuvable: %s — fallback vers %s", use_case_slug, DEFAULT_USE_CASE)
        use_case = load_use_case(DEFAULT_USE_CASE)
    logger.info("Use case chargé: %s (%s)", use_case.slug, use_case.name)

    source = job_meta.get("source")
    is_zoom = source == "zoom"
    is_outbound = source == "outbound"
    logger.info(
        "LLM bound: provider=%s model=%s (slug=%s)",
        resolve_llm_provider(use_case), use_case.llm_model, use_case.slug,
    )
    session = build_session(use_case)
    agent = ConfigurableAgent(use_case, ctx=ctx, wake_word_required=is_zoom)
    start_time = datetime.now()
    room_name = ctx.room.name

    async def _shutdown():
        await write_summary(agent, start_time, room_name)

    ctx.add_shutdown_callback(_shutdown)

    await session.start(agent=agent, room=ctx.room)

    if is_zoom:
        await run_zoom(ctx, session, agent)
    elif is_outbound:
        await run_outbound(ctx, session, agent)
    else:
        await run_inbound(ctx, session, agent)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        agent_name=AGENT_NAME,
        # Summary generation on shutdown calls Sonnet and regularly exceeds
        # the 10 s default, which SIGKILLs the process before the summary
        # file is written. 90 s covers a multi-turn transcript comfortably.
        shutdown_process_timeout=90.0,
    ))
