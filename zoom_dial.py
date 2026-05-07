"""Dispatch L'Analyste into a Zoom meeting via outbound SIP dial-in.

Usage:
    python zoom_dial.py <meeting_id> [--passcode <code>] [--number <+E164>]

Environment (loaded from .env.local):
    LIVEKIT_URL
    LIVEKIT_API_KEY
    LIVEKIT_API_SECRET
    ZOOM_OUTBOUND_TRUNK_ID   LiveKit SIP outbound trunk ID for PSTN dialing
    ZOOM_DIAL_IN_NUMBER      Optional Zoom dial-in PSTN number (E.164)

Prerequisite: configure an outbound SIP trunk in LiveKit Cloud and export its
ID as ZOOM_OUTBOUND_TRUNK_ID. The trunk must be allowed to place PSTN calls.
"""

import argparse
import asyncio
import os
import uuid

from dotenv import load_dotenv
from livekit import api

from use_case import load as load_use_case

load_dotenv(".env.local")

DEFAULT_ZOOM_NUMBER = "+16699006833"


def build_dtmf(meeting_id: str, passcode: str | None) -> str:
    """Zoom dial-in DTMF with pauses matching the one-tap pattern.

    LiveKit SIP: 'w' = 0.5s pause. Zoom one-tap uses ',,' before the ID (2s)
    and ',,,,' before the passcode (4s). With a passcode, `*<code>#` bypasses
    the host-key prompt; without one, we send `#` after a pause to skip it.
    """
    seq = "wwww" + f"{meeting_id}#"
    if passcode:
        seq += "wwwwwwww" + f"*{passcode}#"
    else:
        seq += "wwwwwwww" + "#"
    return seq


async def join_zoom(
    meeting_id: str,
    passcode: str | None,
    zoom_number: str,
    use_case: str | None,
    agent_name: str | None = None,
) -> None:
    trunk_id = os.environ["ZOOM_OUTBOUND_TRUNK_ID"]
    room_name = f"zoom-{meeting_id}-{uuid.uuid4().hex[:6]}"
    dtmf = build_dtmf(meeting_id, passcode)

    import json as _json
    metadata = {"source": "zoom"}
    if use_case:
        metadata["use_case"] = use_case
    # One worker per use case: target the agent_name declared in the use
    # case's YAML. Fallback to DEFAULT_USE_CASE if caller didn't pass --use-case.
    resolved_agent = agent_name or load_use_case(
        use_case or os.environ.get("DEFAULT_USE_CASE")
    ).resolved_agent_name

    lkapi = api.LiveKitAPI(
        url=os.environ["LIVEKIT_URL"],
        api_key=os.environ["LIVEKIT_API_KEY"],
        api_secret=os.environ["LIVEKIT_API_SECRET"],
    )
    try:
        await lkapi.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                agent_name=resolved_agent,
                room=room_name,
                metadata=_json.dumps(metadata),
            )
        )
        print(f"Agent '{resolved_agent}' dispatched to room '{room_name}'")

        participant = await lkapi.sip.create_sip_participant(
            api.CreateSIPParticipantRequest(
                sip_trunk_id=trunk_id,
                sip_call_to=zoom_number,
                room_name=room_name,
                participant_identity="zoom-bridge",
                participant_name="Zoom",
                dtmf=dtmf,
                play_dialtone=True,
                wait_until_answered=True,
            )
        )
        print(
            f"Dialed Zoom {zoom_number} (meeting {meeting_id}), "
            f"SIP participant '{participant.participant_identity}' answered."
        )
    finally:
        await lkapi.aclose()


def main() -> None:
    parser = argparse.ArgumentParser(description="Join a Zoom meeting as L'Analyste.")
    parser.add_argument("meeting_id", help="Zoom meeting ID (digits, no spaces)")
    parser.add_argument("--passcode", help="Numeric dial-in passcode (if the meeting requires one)")
    parser.add_argument(
        "--number",
        default=os.environ.get("ZOOM_DIAL_IN_NUMBER", DEFAULT_ZOOM_NUMBER),
        help=f"Zoom dial-in number in E.164 format (default: {DEFAULT_ZOOM_NUMBER})",
    )
    parser.add_argument(
        "--use-case",
        help="Use case slug from use_cases/ (overrides DEFAULT_USE_CASE env)",
    )
    parser.add_argument(
        "--agent-name",
        dest="agent_name",
        default=None,
        help="Override the dispatched worker name. By default read from the "
             "use case's YAML `agent_name` (defaults to the slug).",
    )
    args = parser.parse_args()
    asyncio.run(join_zoom(
        args.meeting_id, args.passcode, args.number, args.use_case, args.agent_name,
    ))


if __name__ == "__main__":
    main()
