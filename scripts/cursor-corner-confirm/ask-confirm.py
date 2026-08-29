#!/usr/bin/env python3
"""Show approval UI in the bottom-right corner window."""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
import urllib.error
import urllib.request

CONFIRM_URL = "http://127.0.0.1:3456"
SKIP_MCP_SERVERS = {"cursor-ide-browser", "cursor-app-control", "cursor"}
SAFE_BINS = {
    "ls",
    "pwd",
    "echo",
    "printf",
    "true",
    "false",
    "date",
    "whoami",
    "uname",
    "hostname",
    "head",
    "tail",
    "wc",
    "file",
    "which",
    "type",
    "cat",
    "sed",
    "rg",
    "grep",
    "awk",
    "stat",
    "du",
    "df",
    "tree",
    "cd",
    "command",
}
GIT_SAFE = {"status", "diff", "log", "show", "branch", "rev-parse", "describe", "remote"}
GIT_DANGEROUS = {"-d", "-D", "--delete", "-m", "-M"}


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()
    raise SystemExit(0)


def allow() -> None:
    emit({"permission": "allow", "continue": True})


def ask_native(message: str | None = None) -> None:
    payload: dict = {"permission": "ask"}
    if message:
        payload["user_message"] = message
    emit(payload)


def deny(user_message: str, agent_message: str) -> None:
    emit(
        {
            "permission": "deny",
            "user_message": user_message,
            "agent_message": agent_message,
        }
    )


def clip(text: str, limit: int = 220) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def is_safe_command(command: str) -> bool:
    chunks = [part.strip() for part in re.split(r"&&|\|\||;", command) if part.strip()]
    return bool(chunks) and all(is_safe_shell(part) for part in chunks)


def is_safe_shell(part: str) -> bool:
    text = part.strip()
    if not text or ">" in text:
        return False
    try:
        tokens = shlex.split(text)
    except ValueError:
        return False
    if not tokens:
        return True
    binary = os.path.basename(tokens[0])
    if binary == "git":
        args = tokens[1:]
        while args and args[0] in {"--no-pager", "-c"}:
            args = args[2:] if args[0] == "-c" else args[1:]
        sub = args[0] if args else ""
        if sub not in GIT_SAFE or any(flag in GIT_DANGEROUS for flag in args):
            return False
        return True
    if binary == "curl" and "127.0.0.1:3456" in text:
        return True
    return binary in SAFE_BINS


def confirm_up() -> bool:
    try:
        with urllib.request.urlopen(f"{CONFIRM_URL}/ping", timeout=0.4) as resp:
            return resp.status == 200
    except Exception:
        return False


def ask_corner(title: str, detail: str) -> str:
    body = json.dumps({"title": title, "detail": detail}, ensure_ascii=False).encode()
    req = urllib.request.Request(
        f"{CONFIRM_URL}/ask",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=112) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return str(data.get("decision") or "timeout")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return "timeout"


def summarize(data: dict) -> tuple[str, str]:
    command = str(data.get("command") or "").strip()
    tool_name = str(
        data.get("tool_name") or data.get("toolName") or data.get("tool") or ""
    ).strip()
    tool_input = data.get("tool_input") or data.get("input") or data.get("arguments") or ""

    if command and not tool_name:
        return "终端命令", clip(command)

    if tool_name in {"Read", "Glob", "Grep", "SemanticSearch", "AskQuestion"}:
        allow()

    if tool_name in {"Write", "StrReplace", "Delete"}:
        if isinstance(tool_input, str):
            try:
                tool_input = json.loads(tool_input)
            except json.JSONDecodeError:
                pass
        if isinstance(tool_input, dict):
            path = tool_input.get("path") or tool_input.get("target_notebook") or ""
            return f"修改文件 · {tool_name}", clip(
                str(path) or json.dumps(tool_input, ensure_ascii=False)
            )

    title = tool_name or "需要你确认"
    if isinstance(tool_input, str):
        detail = tool_input
    else:
        detail = json.dumps(tool_input, ensure_ascii=False)
    return title, clip(detail or "Agent 想执行一项操作")


def main() -> None:
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        ask_native()

    if str(data.get("mcp_server") or "") in SKIP_MCP_SERVERS:
        allow()

    command = str(data.get("command") or "")
    tool_name = str(data.get("tool_name") or data.get("toolName") or "")
    if command and not tool_name and is_safe_command(command):
        allow()

    if not confirm_up():
        ask_native("请双击 ~/.cursor/desktop-confirm/启动确认窗.command 启动确认窗")

    title, detail = summarize(data)
    decision = ask_corner(title, detail)
    if decision == "allow":
        allow()
    if decision == "deny":
        deny("已在右下角拒绝", "Denied in corner window.")
    ask_native("确认超时，请在对话里确认")


if __name__ == "__main__":
    main()
