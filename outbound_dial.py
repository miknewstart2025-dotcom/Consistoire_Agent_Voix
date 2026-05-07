"""Dispatch a use case agent and place an outbound PSTN call.

Usage:
    python outbound_dial.py <+E164_number> [--use-case <slug>]

Example:
    python outbound_dial.py +14156021250 --use-case consistoire-paris

Environment (loaded from .env.local):
    LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
    ZOOM_OUTBOUND_TRUNK_ID    reused as the generic PSTN outbound trunk
"""

import argparse
import asyncio
import json as _json
import os
import uuid

from dotenv import load_dotenv
from livekit import api

from use_case import load as load_use_case

load_dotenv(".env.local")


async def place_call(
    number: str,
    use_case: str,
    from_number: str | None = None,
    agent_name: str | None = None,
) -> None:
    trunk_id = os.environ["ZOOM_OUTBOUND_TRUNK_ID"]
    room_name = f"out-{use_case}-{uuid.uuid4().hex[:6]}"
    metadata = {"source": "outbound", "use_case": use_case}
    # One worker per use case: target the agent_name declared in the
    # use case's YAML, unless the caller passed an explicit override.
    resolved_agent = agent_name or load_use_case(use_case).resolved_agent_name

    req_kwargs = dict(
        sip_trunk_id=trunk_id,
        sip_call_to=number,
        room_name=room_name,
        participant_identity="callee",
        participant_name=f"Callee {number}",
        play_dialtone=False,
        wait_until_answered=True,
        krisp_enabled=True,
    )
    if from_number:
        req_kwargs["sip_number"] = from_number

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
        print(f"Agent '{resolved_agent}' dispatched to room '{room_name}' ({use_case})")

        participant = await lkapi.sip.create_sip_participant(
            api.CreateSIPParticipantRequest(**req_kwargs)
        )
        caller_id = from_number or "(trunk default)"
        print(
            f"Dialed {number} from {caller_id} — SIP participant "
            f"'{participant.participant_identity}' answered."
        )
    finally:
        await lkapi.aclose()


def main() -> None:
    parser = argparse.ArgumentParser(description="Place an outbound PSTN call from a use case agent.")
    parser.add_argument("number", help="Destination phone number in E.164 format, e.g. +14156021250")
    parser.add_argument(
        "--use-case",
        default="consistoire-paris",
        help="Use case slug from use_cases/ (default: consistoire-paris)",
    )
    parser.add_argument(
        "--from",
        dest="from_number",
        default=None,
        help="Override caller ID in E.164 (must be authorized on the trunk).",
    )
    parser.add_argument(
        "--agent-name",
        dest="agent_name",
        default=None,
        help="Override the dispatched worker name. By default read from the "
             "use case's YAML `agent_name` (defaults to the slug).",
    )
    args = parser.parse_args()
    asyncio.run(place_call(args.number, args.use_case, args.from_number, args.agent_name))


if __name__ == "__main__":
    main()
