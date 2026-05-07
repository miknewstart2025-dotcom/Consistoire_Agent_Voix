# Joining Zoom / Teams / Meet with L'Analyste

This note surveys the ways an interactive voice agent (like L'Analyste) can
join a conferencing platform, what each approach costs in effort and money,
and which is recommended for what situation.

---

## The two fundamental approaches

### 1. PSTN / SIP dial-in (what we ship today)

The agent places an **outbound phone call** into the meeting's dial-in
bridge and navigates the IVR with DTMF to enter the meeting ID / passcode.

- **Current implementation:** `zoom_dial.py` → LiveKit outbound SIP trunk
  (Twilio) → Zoom's PSTN number → DTMF → meeting joined, audio bridged to
  LiveKit room where the agent is dispatched.
- Works **without any Zoom/Teams/Meet developer account**.
- Displays as a phone-number caller ID in the participant list — never as
  "L'Analyste".
- Audio is narrowband (PSTN) — ~8 kHz, noticeably lower quality than the
  HD audio other Zoom participants use.
- Works across Zoom and (with format tweaks) Teams. Google Meet does not
  offer dial-in on most accounts.

### 2. Meeting-bot SDK (what Fireflies, Otter, Fathom, Read, etc. use)

A **headless browser or SDK instance** joins the meeting as a first-class
participant, appearing with a chosen display name and avatar. Audio is HD
WebRTC in both directions.

- Either you implement it yourself using Zoom's Meeting SDK / Teams's
  equivalent (weeks of work per platform), **or** you use a managed bot
  API that abstracts the SDK complexity.
- Managed options: **Recall.ai** (closed-source, industry default),
  **Attendee.dev** (open-source, self-hostable), **MeetingBaas** (managed).
- Works identically across Zoom / Teams / Meet — same endpoint takes any
  meeting URL, the service detects the platform.
- Bot audio is HD, bidirectional, and the participant list shows
  "L'Analyste" (or whatever `bot_name` you pass).

---

## How a meeting-bot API actually works

```
                ┌───────────────────┐
                │  your backend     │
                │  (LiveKit +       │
                │  STT+LLM+TTS)     │
                └─────────┬─────────┘
             inbound      │      outbound
             audio WS     │      audio WS
                          ▼
                ┌───────────────────┐
                │  bot-API service  │
                │  (Recall/Attendee)│
                └─────────┬─────────┘
                          │
                          │ headless Chromium + SDK
                          ▼
                ┌───────────────────┐
                │  Zoom / Teams /   │
                │  Meet meeting     │
                └───────────────────┘
```

Integration pattern:

1. Your backend receives the meeting URL (Zoom, Teams, or Meet — the bot
   API detects the platform).
2. You `POST /bots/ {meeting_url, bot_name: "L'Analyste"}` to the bot API.
3. The service spawns a headless browser that joins the meeting.
4. Inbound audio streams to your backend over a websocket.
5. You pipe it through Deepgram STT → Claude LLM → ElevenLabs TTS.
6. You stream TTS audio back to the bot's output websocket; the bot plays
   it through its virtual microphone into the meeting.

---

## Self-hosting Attendee (the open-source option)

Attendee is a Django app packaged as a single Docker image. Only
external dependencies are Postgres and Redis.

### Local dev

```bash
git clone https://github.com/attendee-labs/attendee
cd attendee
docker compose -f dev.docker-compose.yaml build        # ~5 min
python init_env.py                                     # writes .env
# edit .env with AWS creds (S3 for recordings)
docker compose -f dev.docker-compose.yaml up
docker compose exec web python manage.py migrate
# register at http://localhost:8000, generate an API key
```

### Credentials you need

| What | Source | Notes |
|---|---|---|
| Zoom OAuth (Client ID + Secret) | Zoom Marketplace → Server-to-Server OAuth app | Dev mode works immediately; production use requires Zoom app approval |
| Microsoft Entra / Teams app creds | Azure Portal → App registration with `OnlineMeetings.ReadWrite.All` | Only needed if joining Teams meetings |
| Google OAuth | Google Cloud Console → OAuth client | Only needed for Meet |
| Deepgram key | Already present in `.env.local` | Attendee uses it for transcription; unrelated to L'Analyste's STT |
| AWS (S3 + IAM) | AWS console | For recording storage |

### Production considerations

- Run behind TLS (Caddy / Traefik). Zoom SDK webhooks require HTTPS.
- Scale Celery workers separately from the Django web process. Each active
  bot is a headless Chromium instance — budget **~1 vCPU + 1-2 GB RAM per
  concurrent meeting**.
- Attendee emits lifecycle webhooks (bot joined, meeting ended, transcript
  ready) — wire these into your observability.
- Chromium in containers requires `--no-sandbox` or a seccomp profile;
  Attendee's Dockerfile handles this but you may need to adjust for your
  orchestrator.

---

## What this means for L'Analyste

The logic split we already have in `agent.py` (`run_inbound` vs
`run_zoom`) carries over cleanly. Adding a bot-API path means adding a
third entrypoint, e.g. `run_bot`, that:

- Skips the `wait_for_participant("zoom-bridge") + sip.callStatus=="active"`
  gating (no SIP bridge exists).
- Instead waits for the bot service to signal "joined" via a webhook or a
  metadata update on the room.
- Greets normally, then loads the briefing.

The dispatcher (`zoom_dial.py`) would be replaced by a
`bot_dispatch.py` that:

- Hits `POST /bots/` on the bot API with the meeting URL and `bot_name`.
- Dispatches the agent to a new LiveKit room with
  `metadata='{"source": "bot"}'`.
- Wires the bot's inbound audio websocket into that room as a participant
  track (or pipes it directly to `AgentSession.input.audio`, bypassing
  LiveKit's room model entirely).
- Wires the room's outbound audio back to the bot's output websocket.

---

## Decision matrix

| Need | Best path |
|---|---|
| Demo or internal use, today, any dial-in meeting | PSTN (current `zoom_dial.py`) |
| Multi-platform (Zoom + Teams + Meet) from one code path | Managed bot API (Recall.ai) |
| Customer-facing product, brand control, long-term cost predictability | Self-hosted Attendee |
| Fully bespoke bot behavior, avatar, co-host powers | Build against Zoom Meeting SDK directly |

---

## Cost sketch (April 2026)

- **PSTN path:** Twilio outbound ~$0.013/min + LiveKit Cloud minutes +
  STT/LLM/TTS. Narrowband audio.
- **Recall.ai:** ~$0.15–0.30/min per bot + your STT/LLM/TTS. HD audio, all
  platforms, zero ops.
- **Attendee.dev self-hosted:** compute for the Django app + one Chromium
  instance per concurrent bot (~$0.02/min at moderate scale on a
  reasonably-priced VPS) + STT/LLM/TTS. HD audio, all platforms, ops cost.

---

## References

- Attendee: https://github.com/attendee-labs/attendee
- Recall.ai: https://www.recall.ai
- MeetingBaas: https://meetingbaas.com
- Zoom Meeting SDK: https://developers.zoom.us/docs/meeting-sdk/
- LiveKit SIP: https://docs.livekit.io/sip/
