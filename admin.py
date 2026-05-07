"""Streamlit admin UI to manage use cases and launch the agent.

Run with:
    .venv/bin/streamlit run admin.py
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import streamlit as st
from dotenv import load_dotenv

from use_case import (
    DEFAULT_SLUG,
    UseCase,
    delete as delete_use_case,
    list_slugs,
    load as load_use_case,
    save as save_use_case,
)

load_dotenv(".env.local")

st.set_page_config(page_title="Agent Vocal — Admin", layout="wide")

# ----------------------------------------------------------------------------
# Sidebar — use case picker

slugs = list_slugs() or [DEFAULT_SLUG]
st.sidebar.title("Use cases")
selected = st.sidebar.radio("Edit", slugs, index=0, key="selected_slug")

if st.sidebar.button("➕ New use case"):
    new_slug = f"use-case-{len(slugs) + 1}"
    blank = UseCase(
        slug=new_slug,
        name="Nouveau cas d'usage",
        description="",
        language="fr",
        voice_id="nPczCjzI2devNBz1zQrb",
        system_prompt="Tu es un assistant vocal serviable.",
        greeting="Bonjour, comment puis-je vous aider?",
    )
    save_use_case(blank)
    st.rerun()

# ----------------------------------------------------------------------------
# Main editor

uc = load_use_case(selected)

st.title(uc.name)
st.caption(f"slug: `{uc.slug}`")

tab_config, tab_prompt, tab_briefing, tab_launch, tab_summaries = st.tabs(
    ["⚙️ Config", "🧠 System prompt", "📰 Briefing", "🚀 Launch", "📋 Résumés"]
)

with tab_config:
    col1, col2 = st.columns(2)
    with col1:
        name = st.text_input("Name", uc.name)
        description = st.text_area("Description", uc.description, height=80)
        language = st.selectbox("Language", ["fr", "en", "es", "de", "it"],
                                index=["fr", "en", "es", "de", "it"].index(uc.language) if uc.language in ["fr", "en", "es", "de", "it"] else 0)
        wake_word = st.text_input(
            "Wake word (empty = respond every turn)",
            uc.wake_word or "",
            help='e.g. "hello mira" for multi-party meetings',
        )
        disconnect_word = st.text_input(
            "Disconnect phrase (empty = no phrase hangup)",
            uc.disconnect_word or "",
            help='e.g. "bye Gene" — when the caller says this, the agent '
                 'plays a short localized farewell and hangs up.',
        )
        turn_fillers_raw = st.text_area(
            "Turn fillers (one per line, empty = disabled)",
            "\n".join(uc.turn_fillers),
            height=120,
            help='Short interjections (e.g. "Hmm.", "Alors…") spoken if the '
                 "LLM/TTS pipeline hasn't replied within 700 ms. One is "
                 "picked at random per turn; cancelled when the real reply "
                 "starts.",
        )
    with col2:
        voice_id = st.text_input("ElevenLabs voice_id", uc.voice_id)
        tts_model = st.text_input("TTS model", uc.tts_model)
        llm_provider_options = ["auto", "anthropic", "openai"]
        current_provider = (uc.llm_provider or "auto").lower()
        llm_provider = st.selectbox(
            "LLM provider",
            llm_provider_options,
            index=llm_provider_options.index(current_provider) if current_provider in llm_provider_options else 0,
            help="'auto' = infer from model ID (claude-* → anthropic, gpt-*/o[1-4]-* → openai).",
        )
        llm_model = st.text_input(
            "LLM model",
            uc.llm_model,
            help="e.g. claude-sonnet-4-6, claude-opus-4-7, gpt-4.1, o3-mini",
        )
        stt_model = st.text_input("STT model (Deepgram)", uc.stt_model)
        stt_language = st.text_input("STT language code", uc.stt_language)

    greeting = st.text_area("Greeting (spoken on connect)", uc.greeting, height=100)
    briefing_prelude = st.text_input(
        "Briefing prelude (prefixes the injected briefing)", uc.briefing_prelude
    )

    st.divider()
    st.subheader("Inbound access control")
    inbound_number = st.text_input(
        "Inbound phone number (E.164, documentary)",
        uc.inbound_number,
        help="The PSTN number this use case answers on. Recorded for "
             "reference only — actual routing is set via `lk sip dispatch "
             "create use_cases/<slug>.dispatch.json`.",
    )
    access = st.radio(
        "Access",
        ["public", "restricted"],
        index=1 if (uc.access or "public").lower() == "restricted" else 0,
        horizontal=True,
        help="Public: any inbound caller accepted. Restricted: only numbers below.",
    )
    authorized_numbers_raw = st.text_area(
        "Authorized numbers (comma-separated, E.164)",
        ", ".join(uc.authorized_numbers),
        height=80,
        help="Only used when access = restricted. e.g. +33612345678, +44207946000",
        disabled=access == "public",
    )

with tab_prompt:
    system_prompt = st.text_area(
        "System prompt", uc.system_prompt, height=500,
        help="Persona, tone, knowledge domains, operational constraints.",
    )

with tab_briefing:
    st.caption(
        "Markdown reference content injected as a system message after the "
        "greeting. Useful for ephemeral facts (press veille, product catalog, "
        "FAQs) that change more often than the persona."
    )
    briefing = st.text_area("Briefing (markdown)", uc.briefing, height=500)

with tab_launch:
    st.subheader("Launch in Zoom")
    col1, col2 = st.columns([2, 1])
    with col1:
        meeting_id = st.text_input("Meeting ID", key="meeting_id")
        passcode = st.text_input("Passcode (numeric)", key="passcode")
    with col2:
        st.write("")
        st.write("")
        if st.button("📞 Dial in", type="primary", use_container_width=True):
            if not meeting_id:
                st.error("Meeting ID required")
            else:
                cmd = [
                    sys.executable, "zoom_dial.py", meeting_id,
                    "--use-case", uc.slug,
                ]
                if passcode:
                    cmd += ["--passcode", passcode]
                result = subprocess.run(
                    cmd, capture_output=True, text=True,
                    cwd=Path(__file__).parent,
                )
                if result.returncode == 0:
                    st.success(result.stdout)
                else:
                    st.error(result.stderr or result.stdout)

    st.divider()
    st.subheader("Appel sortant PSTN")
    col1, col2 = st.columns([2, 1])
    with col1:
        outbound_number = st.text_input(
            "Numéro à appeler (E.164)",
            placeholder="+33612345678",
            key="outbound_number",
        )
        outbound_from = st.text_input(
            "Numéro appelant (optionnel)",
            key="outbound_from",
            help="Override du caller ID si le trunk le permet.",
        )
    with col2:
        st.write("")
        st.write("")
        if st.button("📞 Appeler", type="primary", use_container_width=True):
            if not outbound_number:
                st.error("Numéro requis")
            else:
                cmd = [
                    sys.executable, "outbound_dial.py", outbound_number,
                    "--use-case", uc.slug,
                ]
                if outbound_from.strip():
                    cmd += ["--from", outbound_from.strip()]
                result = subprocess.run(
                    cmd, capture_output=True, text=True,
                    cwd=Path(__file__).parent,
                )
                if result.returncode == 0:
                    st.success(result.stdout)
                else:
                    st.error(result.stderr or result.stdout)

    st.divider()
    st.subheader("Entrant")
    st.info(
        f"Appeler le trunk SIP entrant. Définir `DEFAULT_USE_CASE={uc.slug}` dans "
        "`.env.local` pour router les appels entrants vers ce cas d'usage, ou "
        "passer le cas via les métadonnées du job."
    )

with tab_summaries:
    summaries_dir = Path(__file__).parent / "summaries"
    all_files = sorted(summaries_dir.glob(f"*_{uc.slug}_*.md"), reverse=True)
    if not all_files:
        st.info("Aucun résumé pour ce cas d'usage.")
    else:
        st.caption(f"{len(all_files)} résumé(s) trouvé(s) pour `{uc.slug}`.")
        file_labels = [f.name for f in all_files[:30]]
        chosen = st.selectbox("Résumé", file_labels, index=0, key="summary_file")
        chosen_path = summaries_dir / chosen
        if chosen_path.exists():
            content = chosen_path.read_text(encoding="utf-8")
            # Extract header metadata and body
            st.markdown(content)

# ----------------------------------------------------------------------------
# Save / Delete

col_save, col_del, _ = st.columns([1, 1, 4])
with col_save:
    if st.button("💾 Save", type="primary", use_container_width=True):
        save_use_case(UseCase(
            slug=uc.slug,
            name=name, description=description, language=language,
            voice_id=voice_id, tts_model=tts_model,
            llm_provider="" if llm_provider == "auto" else llm_provider,
            llm_model=llm_model,
            stt_model=stt_model, stt_language=stt_language,
            wake_word=wake_word or None,
            disconnect_word=disconnect_word or None,
            turn_fillers=[
                line.strip() for line in (turn_fillers_raw or "").splitlines()
                if line.strip()
            ],
            greeting=greeting, briefing_prelude=briefing_prelude,
            system_prompt=system_prompt, briefing=briefing,
            access=access,
            authorized_numbers=[
                n.strip() for n in (authorized_numbers_raw or "").split(",") if n.strip()
            ],
            inbound_number=inbound_number.strip(),
            # Preserve fields the editor doesn't surface, so the YAML isn't
            # overwritten with defaults.
            escalation_targets=uc.escalation_targets,
            agent_name=uc.agent_name,
            memory_prelude=uc.memory_prelude,
            memory=uc.memory,
            extra=uc.extra,
        ))
        st.success("Saved")
with col_del:
    if st.button("🗑️ Delete", use_container_width=True):
        delete_use_case(uc.slug)
        st.rerun()
