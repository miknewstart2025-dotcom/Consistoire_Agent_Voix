# Voice Agent — configurable personas over LiveKit

A LiveKit voice agent that can take on any persona defined by a **use case
file**. Each use case declares its own `agent_name` in YAML and runs as its
own LiveKit worker, so dispatches route cleanly and we don't fight a pool
of deployed workers for the same name. A worker can still serve several
use cases via dispatch metadata if you choose to point them at a shared
agent name, but the default is one-worker-per-use-case.

**Pipeline**: Deepgram STT · Claude Sonnet 4.6 (or whatever the use case
picks) · ElevenLabs TTS · Silero VAD · LiveKit Cloud for transport.

---

## What's in the box

```
agent.py                         LiveKit worker + entrypoint + function tools
use_case.py                      UseCase dataclass + YAML/markdown loader
summary.py                       End-of-call markdown report + memory append
admin.py                         Streamlit CRUD UI for use cases
zoom_dial.py                     Dispatch the agent into a Zoom meeting via SIP
outbound_dial.py                 Place an outbound PSTN call to any E.164 number
kb.py, kb_build.py               Per-use-case vector KB (Voyage embeddings)
graph.py, graph_build.py         Per-use-case structured fact graph (SQLite)
test_use_cases.py                Static smoke test (load + tool resolution)
zoom_trunk.template.json         Outbound SIP trunk config skeleton
requirements.txt                 Python deps (livekit-agents + Streamlit + PyYAML)
.env.local                       Credentials + DEFAULT_USE_CASE (not in git)

use_cases/
  <slug>.yaml                    Persona + agent_name, voice, models, wake word
  <slug>.briefing.md             Curated reference injected as system message
  <slug>.memory.md               Accumulated call summaries (gitignored)
  <slug>.dispatch.json           Optional SIP dispatch rule snapshot
  <slug>/docs/                   Source documents for the vector KB + graph
  <slug>/.index/                 Built Voyage vectors (gitignored)
  <slug>/.graph/                 Built SQLite fact DB (gitignored)

summaries/                       Per-call markdown reports (gitignored)
zoom-teams-bots.md               Design note: PSTN vs meeting-bot SDKs
```

---

## Setup

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Create `.env.local`:

```
LIVEKIT_URL=wss://<project>.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
DEEPGRAM_API_KEY=...
ANTHROPIC_API_KEY=...
ELEVEN_API_KEY=...
VOYAGE_API_KEY=...              # only if a use case has a docs/ KB

# Which use case the worker serves; drives `agent_name` via its YAML.
DEFAULT_USE_CASE=tae

# Required for Zoom dial-out and outbound PSTN
ZOOM_OUTBOUND_TRUNK_ID=ST_xxx
ZOOM_DIAL_IN_NUMBER=+16699006833

# Required only if a use case declares `escalation_targets`
ESCALATION_OUTBOUND_TRUNK_ID=ST_xxx
```

---

## Run

```bash
DEFAULT_USE_CASE=consistoire-paris .venv/bin/python agent.py dev
```

The worker registers with LiveKit under the `agent_name` declared in the
use case's YAML (`UseCase.resolved_agent_name`, defaults to the slug).
Setting `AGENT_NAME=foo` overrides the YAML for ad-hoc multi-worker
experiments.

**One worker per use case** is the working assumption: run one `agent.py
dev` per slug, each with its own `DEFAULT_USE_CASE`. This avoids the
dispatch-theft problem where a second worker registered under a generic
name (e.g. a deployed copy in LiveKit Cloud) silently steals jobs and
runs stale code — symptom: call connects, greeting plays, agent then goes
mute because the remote worker 400s on an old tool schema. When in doubt
pick a unique `agent_name` like `tae-laurent-local` and align the
SIP dispatch rule to match.

Hot-reload is on in `dev` mode: editing `agent.py` or the use case files
restarts the child process. Hard-restart after config-level changes with
`pkill -9 -f "agent.py dev"` so the subprocess pool re-imports fresh.

---

## How it works

### Use case library

A **use case** is a persona + its knowledge. It lives in two or three
sibling files:

```
use_cases/tae.yaml         (required)
use_cases/tae.briefing.md  (optional — curated domain context)
use_cases/tae.memory.md    (optional — accumulates across calls)
```

The YAML defines the system prompt, TTS voice, LLM model, STT language,
wake word, greeting, and a prelude for each markdown file. Example:

```yaml
name: TAE — Tribunal des Affaires Économiques
description: >
  Conseiller juridique spécialisé sur le Tribunal des Affaires Économiques ...
language: fr
voice_id: XrExE9yKIg1WjnnlVkGX   # ElevenLabs Matilda — premade female
tts_model: eleven_multilingual_v2
llm_model: claude-sonnet-4-6
stt_model: nova-2
stt_language: fr
agent_name: tae                   # LiveKit worker agent_name; defaults to slug
wake_word: null                   # null = respond every turn (Zoom-only gating)
greeting: |
  Bonjour, ici Themis, votre conseillère sur le Tribunal des Activités Économiques. ...
briefing_prelude: >
  Reference cheat sheet. Cite specifics; do not read aloud.
memory_prelude: >
  Summaries of past calls. Reference prior decisions when relevant.
escalation_targets:               # optional; omit for no escalate_to_human tool
  front desk: "+14156021250"
system_prompt: |
  Role: You are the "Graph Advisor", a principal-level consultant on ...
```

Voice selection gotchas: `voice_id` is authoritative — verify it via
`GET /v1/voices/{id}` rather than trusting a YAML comment (a wrong ID
will silently produce an English-accent American voice "speaking" French).
Library voices (Augustin, Julien, Raphael…) must be added to the account
via `POST /v1/voices/add/{public_user_id}/{voice_id}` before first use.

`use_case.py` loads YAML + both markdown files into a `UseCase` dataclass.
Missing markdown files are treated as empty; the agent continues without
injecting that layer.

### Persona selection on dispatch

`agent.py:entrypoint` reads `ctx.job.metadata` as JSON and looks for
`use_case`. Resolution order:

1. `metadata.use_case` (per-call override from `zoom_dial.py --use-case`)
2. `DEFAULT_USE_CASE` env var
3. Fallback to `tae` (hard-coded default)

The resolved slug is loaded; if it's missing on disk the agent logs an
error and falls back to `DEFAULT_USE_CASE`.

### Two call flows

`metadata.source == "zoom"` picks `run_zoom`, anything else gets
`run_inbound`.

**`run_inbound`** — an inbound PSTN caller or a web client. The agent is
already in the room when the user arrives, so it greets immediately, then
injects the briefing + memory into chat context.

**`run_zoom`** — `zoom_dial.py` places an outbound SIP call to Zoom's
PSTN number, sends DTMF to navigate the IVR, and the Zoom participant
joins the LiveKit room as `zoom-bridge`. The agent **cannot** greet
immediately — it would play into the Twilio/IVR tunnel before Zoom has
actually accepted the participant. So `run_zoom`:

1. Waits for the `zoom-bridge` participant to appear.
2. Polls `participant.attributes["sip.callStatus"]` every 0.5 s until it
   flips from `"automation"` (DTMF in flight) to `"active"` (meeting
   joined), with a 30 s timeout.
3. Sleeps 3 s to let Zoom's "… has joined the meeting" announcement
   finish.
4. Says the greeting with `allow_interruptions=False` so Zoom's own audio
   can't false-trigger a VAD interrupt and clip the intro.
5. Injects briefing + memory after the greeting plays out.

### Wake-word gating (Zoom only)

Use cases can set `wake_word: "Hello Mira"` to require a phrase before the
agent responds in a multi-party meeting. `use_case.py` builds a tolerant
regex from the phrase (case-insensitive, optional punctuation between
tokens, word boundaries). In `run_zoom` the agent runs with
`wake_word_required=True`; `ConfigurableAgent.on_user_turn_completed`
checks the transcript and either strips the wake phrase or raises
`StopResponse` to skip the LLM for that turn.

**Wake gating only applies when** `metadata.source == "zoom"` **and** the
YAML has a non-null `wake_word`. Inbound 1:1 calls always respond every
turn — they don't need a wake word.

### Structured fact graph + vector KB (optional)

A use case can ship primary-source documents in `use_cases/<slug>/docs/`.
Two complementary retrieval layers sit on top:

**Vector KB** (`kb.py`) — Voyage `voyage-3-large` embeddings, mmap'd
cosine search. Built once with `python kb_build.py <slug>`; exposed to
the LLM as the `lookup_knowledge_base(query, k)` function tool. Good for
narrative/procedural questions ("what is the procedure for a get?").
~300 ms query-embedding latency per call — `agent.py` plays a short
filler (*"One moment, let me check."*) while the embedding runs so the
caller never hears dead air.

**Structured fact graph** (`graph.py`) — SQLite tables populated from
domain-specific extractors in `graph_build.py` (CSV direct-load, or
Claude Haiku PDF → JSON). Each table is exposed as its own function
tool (`find_shops`, `lookup_product`, `check_date`, etc.),
sub-10 ms latency. Every row carries `(source, locator)` so the agent
paraphrases with citations. Client currently has 8 tables /
≈3,700 rows from the catalog.

Bias the LLM toward graph tools by listing the tool→domain mapping in
the system prompt — graph lookups are ~100× faster than the KB call,
so pushing factual questions down to SQLite keeps the voice turn snappy.

Anthropic detail worth remembering: `anthropic.LLM()` in livekit-plugins
defaults to `_strict_tool_schema=True`, which forces every tool
parameter into a union type (`[X, "null"]`). The provider caps schemas
at 16 union-typed parameters total across all tools. Consistoire has
9 tools with ~28 parameters — hits the cap and 400s every turn. Pass
`_strict_tool_schema=False` on the LLM to drop to 0 unions.

### Briefing + memory injection

Both are injected as **separate system messages** after the greeting
plays out:

- **Briefing** is the curated, static reference content you wrote (press
  survey, domain cheat sheet, product FAQ). It changes slowly.
- **Memory** is machine-appended: every call with ≥ 3 user turns writes
  its summary body (no transcript) into `use_cases/<slug>.memory.md`,
  which is loaded on every subsequent call. This lets the agent reference
  prior decisions and recurring themes without replaying raw dialog.

Distinct preludes (`briefing_prelude`, `memory_prelude`) tell the model
which is which. Memory files are gitignored by default — see Privacy
below.

### Escalation to a human

When a use case declares an `escalation_targets` map, the agent gets an
`escalate_to_human(target, reason)` function tool. On invocation:

1. The agent says a hand-off line to the caller (reason is read aloud).
2. It creates an outbound SIP participant via `ESCALATION_OUTBOUND_TRUNK_ID`
   that dials the matched E.164 number and conferences it into the room.
3. Once the operator picks up (`wait_until_answered=True` returns), a
   short briefing line is spoken to the room ("We are connecting you with our customer who needs more information."
   Both the caller and the operator hear it — LiveKit's `session.say`
   broadcasts; per-participant audio isn't currently routed.

International dialing and caller-ID are Twilio concerns: the trunk's
`numbers` field lists authorized caller-IDs (all US for the default
`laurent-outbound-trunk`), so a French recipient sees +1-415 inbound —
increases chances of spam-flagging. Add a local caller-ID number in
Twilio when that matters. Twilio's Geographic Permissions must allow the
destination country (check via a probe INVITE to `+33000000000`-style
sentinel numbers — if accepted without a 403, geo is open).

### End-of-call summaries

Registered via `ctx.add_shutdown_callback` in `agent.py`. On participant
disconnect, `summary.write_summary`:

1. Extracts user/assistant turns from `agent.chat_ctx.items`.
2. Skips if < 3 user turns (hang-ups, voicemail-style pickups).
3. Runs a one-shot `claude-sonnet-4-6` call via `AsyncAnthropic` with a
   fixed 6-section template: Context · Key Topics · Decisions · Action
   Items · Notable Quotes · Open Questions.
4. Writes `summaries/<timestamp>_<slug>_<room>.md` with metadata header
   and the full transcript folded into a `<details>` appendix for audit.
5. Appends the summary body (not the transcript) to
   `use_cases/<slug>.memory.md` so the next call benefits from it.

---

## Admin UI

Streamlit app for managing use cases without editing files by hand.

```bash
.venv/bin/streamlit run admin.py
```

Browser opens at `http://localhost:8501`. Four tabs per use case:

- **Config** — name, description, language, voice_id, models, wake word,
  greeting, prelude strings.
- **System prompt** — large editor for the persona.
- **Briefing** — markdown editor for the curated reference content.
- **Launch** — enter a Zoom meeting ID + passcode and click "Dial in";
  the UI subprocesses `zoom_dial.py --use-case <slug>`.

Sidebar lets you add / switch / delete use cases. Save writes the YAML
and the briefing markdown side by side.

---

## Outbound PSTN

```bash
.venv/bin/python outbound_dial.py +19179154608 \
  --use-case consistoire-paris --from +14158530116
```

Dispatches the use case's worker (YAML `agent_name` → `consistoire-
laurent-local` in this example) into a fresh room, then dials the callee
via `ZOOM_OUTBOUND_TRUNK_ID` with `--from` as the caller-ID. The trunk
must have that caller-ID in its `numbers` field. `--agent-name` overrides
the YAML-derived worker target for debugging.

The outbound flow waits for the callee's `sip.callStatus=="active"`
before greeting (avoids talking into ringing/voicemail) — same pattern
as Zoom but against a real callee participant.

## Zoom dial-out

### One-time: provision an outbound SIP trunk

Inbound trunks can't place outbound calls. This project uses a Twilio
Elastic SIP trunk:

- **Name:** `laurent-outbound-trunk`
- **Address:** `lkoutbound.pstn.twilio.com`
- **Number:** `+14158778332`
- **Transport:** Auto

Re-create via CLI if needed:

```bash
cp zoom_trunk.template.json zoom_trunk.json
# fill in auth_username / auth_password from Twilio SIP trunk credentials
lk sip outbound create zoom_trunk.json
lk sip outbound list                       # copy the SIPTrunkID
```

Put the returned `ST_xxx` into `.env.local` as `ZOOM_OUTBOUND_TRUNK_ID`.
Keep `zoom_trunk.json` out of git — gitignored by default.

### Dial a meeting

```bash
.venv/bin/python zoom_dial.py 1234567890 --passcode 987654 --use-case tae
```

Positional is the numeric meeting ID. `--passcode` is the numeric dial-in
code from the meeting invite (**not** the `pwd=` token in the Zoom URL —
that's a web-client encoding, unrelated to the PSTN passcode).
`--use-case` selects the persona and the agent worker name via the YAML.
`--agent-name` overrides the worker target if you need to debug against
a specific worker.

What happens:

1. Dispatches the agent into a fresh room `zoom-<meeting_id>-<rand>` with
   metadata `{"source": "zoom", "use_case": "<slug>"}`.
2. Creates a SIP participant that dials Zoom's PSTN number.
3. Sends DTMF `wwww<meeting_id>#wwwwwwww*<passcode>#` — four `w`s = 2 s
   pause before the meeting ID, eight `w`s = 4 s pause before the
   passcode, mirroring Zoom's one-tap mobile format. `w` is LiveKit SIP's
   0.5 s pause token.
4. `run_zoom` waits for `sip.callStatus == "active"` + 3 s buffer, then
   the agent greets inside the meeting.

Override the PSTN number with `--number +33170377044` etc.

PSTN dial-out has two known limitations:

- Audio is narrowband (~8 kHz).
- The participant always shows as the caller phone number in Zoom, not as
  the agent name. To fix both, see `zoom-teams-bots.md` for the
  meeting-bot SDK path (Recall.ai / Attendee.dev).

---

## Privacy

- `summaries/` — call summaries include transcript appendices. Always
  gitignored.
- `use_cases/*.memory.md` — accumulated summaries (no transcript) but
  still contain conversation content and SIP room names with phone
  numbers. Gitignored by default. If you want to sync memory across
  machines, do it out-of-band (rsync, encrypted cloud storage).
- `.env.local` — all API keys. Never committed.
- `zoom_trunk.json` — Twilio SIP credentials. Never committed (use the
  `.template.json` for sharing structure).

---

## Dev tips

- **Agent name collisions**: each use case declares its own `agent_name`
  in YAML; picking a unique suffix like `-laurent-local` avoids the
  historic case where 20+ deployed workers fought over a generic name
  and stole dispatches. Align the SIP dispatch rule to the same name.
- **Watch the worker log** to see which flow ran, wake-gate outcomes,
  briefing/memory sizes, and summary path:
  ```
  Inbound flow: warmup then greeting
  Briefing loaded (5001 characters)
  Memory loaded (2016 characters)
  Wake word absent, response ignored: '...'
  Summary saved: summaries/2026-04-21_consistoire-paris_sip-...md
  ```
- **Restart cleanly**: `pkill -9 -f "agent\.py dev"` if hot reload
  wedges, then restart — a fresh parent avoids stale subprocess imports.
- **Static smoke test**: `.venv/bin/python test_use_cases.py` validates
  every YAML parses, agent_names resolve, briefings load, and per-use-case
  tool wiring matches (KB chunk count, graph row counts).
- **Test a use case without a call**: `use_case.py` is importable;
  `load("tae")` returns a fully hydrated dataclass.
- **First-word clipped on PSTN**: a 600 ms `asyncio.sleep` before the
  greeting in `run_inbound` lets Twilio/LiveKit's jitter buffer warm —
  without it TTS starts playing before the media path stabilises.
