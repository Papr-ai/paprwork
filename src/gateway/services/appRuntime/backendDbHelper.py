#!/usr/bin/env python3
"""Mini-app backend DB helper — local SQLite or Turso (stdlib-only).

Env (injected by gateway when app has linked data-sources.json):
  PAPR_DB_MODE=local|turso
  APP_DB              — local SQLite path (local mode)
  PAPR_DB_URL         — libsql URL (turso mode)
  PAPR_DB_AUTH_TOKEN  — Turso auth token (turso mode)

Usage:
  from papr_db import connect, execute, executemany

  con = connect()
  execute(con, "INSERT INTO items (name) VALUES (?)", ["hello"])
  rows = execute(con, "SELECT name FROM items")
  con.close()
"""
from __future__ import annotations

import json
import os
import sqlite3
import urllib.error
import urllib.request
from typing import Any


def db_mode() -> str:
    return os.environ.get("PAPR_DB_MODE", "")


def connect() -> sqlite3.Connection | "_TursoConnection":
    mode = db_mode()
    if mode == "local":
        path = os.environ.get("APP_DB", "")
        if not path:
            raise RuntimeError("APP_DB not set — link_app_data_source first")
        return sqlite3.connect(path)
    if mode == "turso":
        url = os.environ.get("PAPR_DB_URL", "")
        token = os.environ.get("PAPR_DB_AUTH_TOKEN", "")
        if not url or not token:
            raise RuntimeError("PAPR_DB_URL / PAPR_DB_AUTH_TOKEN not set")
        return _TursoConnection(url, token)
    raise RuntimeError(
        "No linked database — call link_app_data_source before using papr_db"
    )


def execute(
    con: sqlite3.Connection | "_TursoConnection",
    sql: str,
    params: list[Any] | tuple[Any, ...] | None = None,
) -> list[dict[str, Any]] | int:
    args = list(params or [])
    if isinstance(con, sqlite3.Connection):
        cur = con.cursor()
        cur.execute(sql, args)
        if sql.strip().upper().startswith("SELECT"):
            cols = [d[0] for d in cur.description or []]
            return [dict(zip(cols, row)) for row in cur.fetchall()]
        con.commit()
        return cur.rowcount
    return con.execute(sql, args)


def executemany(
    con: sqlite3.Connection | "_TursoConnection",
    sql: str,
    seq: list[list[Any] | tuple[Any, ...]],
) -> int:
    if isinstance(con, sqlite3.Connection):
        cur = con.cursor()
        cur.executemany(sql, seq)
        con.commit()
        return cur.rowcount
    total = 0
    for params in seq:
        total += int(con.execute(sql, list(params)))
    return total


class _TursoConnection:
    """Minimal Turso/libsql HTTP client (stdlib only)."""

    def __init__(self, libsql_url: str, auth_token: str) -> None:
        self._url = _http_url(libsql_url)
        self._token = auth_token

    def execute(
        self,
        sql: str,
        params: list[Any] | None = None,
    ) -> list[dict[str, Any]] | int:
        body = json.dumps(
            {"statements": [{"q": sql, "params": params or []}]},
        ).encode("utf-8")
        req = urllib.request.Request(
            self._url,
            data=body,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"Turso HTTP {exc.code}: {detail}") from exc

        results = payload.get("results") or payload.get("result") or []
        if not results:
            return 0 if not sql.strip().upper().startswith("SELECT") else []

        first = results[0]
        if first.get("type") == "error":
            raise RuntimeError(first.get("error", {}).get("message", "Turso error"))

        response = first.get("response") or first
        rtype = response.get("type")
        if rtype == "execute":
            if sql.strip().upper().startswith("SELECT"):
                cols = response.get("result", {}).get("cols") or []
                names = [c.get("name", f"c{i}") for i, c in enumerate(cols)]
                rows = response.get("result", {}).get("rows") or []
                out: list[dict[str, Any]] = []
                for row in rows:
                    out.append(dict(zip(names, row)))
                return out
            return int(response.get("result", {}).get("affected_row_count", 0))

        if rtype == "rows":
            cols = response.get("cols") or []
            names = [c.get("name", f"c{i}") for i, c in enumerate(cols)]
            rows = response.get("rows") or []
            return [dict(zip(names, row)) for row in rows]

        return 0

    def close(self) -> None:
        return None


def _http_url(libsql_url: str) -> str:
    if libsql_url.startswith("libsql://"):
        return "https://" + libsql_url[len("libsql://") :]
    if libsql_url.startswith("https://"):
        return libsql_url
    if libsql_url.startswith("http://"):
        return libsql_url
    return "https://" + libsql_url
