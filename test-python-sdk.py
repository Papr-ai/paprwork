#!/usr/bin/env python3
"""Ad-hoc Papr Python SDK test. Requires PAPR_API_KEY and PAPR_TEST_CHAT_ID in env."""

from __future__ import annotations

import asyncio
import os
import sys

from papr import Papr


async def test_retrieve_history() -> None:
    api_key = os.environ.get("PAPR_API_KEY")
    chat_id = os.environ.get("PAPR_TEST_CHAT_ID")
    if not api_key:
        print("❌ PAPR_API_KEY required", file=sys.stderr)
        sys.exit(1)
    if not chat_id:
        print("❌ PAPR_TEST_CHAT_ID required", file=sys.stderr)
        sys.exit(1)

    client = Papr(x_api_key=api_key)

    print("Testing Python SDK (what Paprwork uses):")
    print("=" * 80)

    for limit in [10, 50, 100]:
        print(f"\nLimit={limit}:")
        response = await client.messages.sessions.retrieve_history(
            session_id=chat_id,
            limit=limit,
        )

        role_count: dict[str, int] = {}
        for msg in response.messages:
            role_count[msg.role] = role_count.get(msg.role, 0) + 1

        print(f"  Retrieved: {len(response.messages)}/{response.total_count} messages")
        print(f"  Roles: {role_count}")


if __name__ == "__main__":
    asyncio.run(test_retrieve_history())
