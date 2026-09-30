#!/usr/bin/env python3
"""Bottom-right approval window server for Cursor hooks."""

from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 3456
TIMEOUT_SEC = 110

PENDING: queue.Queue[dict] = queue.Queue()
CURRENT_EVENT = threading.Event()
CURRENT_EVENT.set()


def run_applescript(script: str) -> None:
    subprocess.run(["osascript", "-e", script], check=False)


def show_dialog(title: str, detail: str) -> str:
    safe_title = title.replace('"', "'")
    safe_detail = detail.replace('"', "'")
    script = f'''
set theTitle to "{safe_title}"
set theDetail to "{safe_detail}"
try
  display dialog theDetail with title theTitle buttons {{"拒绝", "允许"}} default button "允许" giving up after {TIMEOUT_SEC} with icon caution
on error number -128
  return "deny"
end try
if gave up of result then
  return "timeout"
end if
if button returned of result is "允许" then
  return "allow"
end if
return "deny"
'''
    proc = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    return (proc.stdout or "timeout").strip() or "timeout"


def position_window() -> None:
    script = '''
tell application "System Events"
  repeat with p in processes
    if name of p is "osascript" then
      try
        set position of window 1 of p to {960, 620}
        set size of window 1 of p to {420, 220}
      end try
    end if
  end repeat
end tell
'''
    run_applescript(script)


def worker() -> None:
    while True:
        item = PENDING.get()
        CURRENT_EVENT.clear()
        position_window()
        item["decision"] = show_dialog(item["title"], item["detail"])
        CURRENT_EVENT.set()
        PENDING.task_done()


class Handler(BaseHTTPRequestHandler):
    server_version = "CursorConfirm/1.0"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[confirm] " + (fmt % args) + "\n")

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        if path == "/ping":
            self._json(200, {"ok": True})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        if path != "/ask":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            payload = json.loads(raw or "{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return
        item = {
            "title": str(payload.get("title") or "需要你确认"),
            "detail": str(payload.get("detail") or "Agent 想执行一项操作"),
            "decision": None,
        }
        PENDING.put(item)
        if not CURRENT_EVENT.wait(timeout=TIMEOUT_SEC + 5):
            self._json(200, {"decision": "timeout"})
            return
        self._json(200, {"decision": item.get("decision") or "timeout"})


def main() -> None:
    threading.Thread(target=worker, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[confirm] listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
