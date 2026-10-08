"""Call the user's connected services (Linear, HubSpot, Stripe, Notion...) from a job.

    from papr_mcp import call, call_json, tools, status

    issues = call_json("linear", "list_issues", {"assignee": "me", "limit": 20})
    print(status("linear"))          # "connected" | "disconnected" | "needs_reauth" | ...

Connections are one-click OAuth sign-ins the user makes in Settings ->
Connections (or Pen's connect_mcp tool). Tokens stay in the keychain; the job
only talks to the local Papr gateway. If a service is not connected the call
raises PaprMcpError telling the user what to do. It never opens a browser.

No pip install: this module is on PYTHONPATH for every job.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

DEFAULT_GATEWAY = "http://127.0.0.1:18789"


class PaprMcpError(RuntimeError):
    pass


def _gateway() -> str:
    return os.environ.get("PAPR_GATEWAY_URL", DEFAULT_GATEWAY).rstrip("/")


def _request(path: str, payload: dict[str, Any] | None = None, timeout: float = 180) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        f"{_gateway()}{path}",
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except (ValueError, AttributeError):
            pass
        raise PaprMcpError(f"{path} failed ({err.code}): {detail}") from err
    except urllib.error.URLError as err:
        raise PaprMcpError(
            f"Cannot reach the Papr gateway at {_gateway()} ({err.reason}). "
            "It runs with the desktop app; start Papr Work and retry."
        ) from err


def status(server: str | None = None) -> Any:
    """State of one server ("connected", "disconnected", ...) or {id: state} for all."""
    servers = _request("/api/mcp/servers").get("servers", [])
    states = {s["id"]: s["state"] for s in servers}
    return states.get(server.lower(), "unknown") if server else states


def tools(server: str) -> list[dict[str, Any]]:
    """Tool names, descriptions and input schemas for a connected server."""
    return _request(f"/api/mcp/servers/{server.lower()}/tools").get("tools", [])


def call(server: str, tool: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
    """Call a tool. Returns {"text", "structuredContent", "isError"}."""
    return _request(
        "/api/mcp/call",
        {"server": server.lower(), "tool": tool, "arguments": arguments or {}},
    )


def call_json(server: str, tool: str, arguments: dict[str, Any] | None = None) -> Any:
    """call() and parse the result: structuredContent if present, else JSON text, else raw text.

    Raises PaprMcpError when the tool reports an error.
    """
    result = call(server, tool, arguments)
    if result.get("isError"):
        raise PaprMcpError(f"{server}.{tool} returned an error: {result.get('text', '')[:500]}")
    if result.get("structuredContent") is not None:
        return result["structuredContent"]
    text = result.get("text", "")
    try:
        return json.loads(text)
    except ValueError:
        return text
