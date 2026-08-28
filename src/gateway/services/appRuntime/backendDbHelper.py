#!/usr/bin/env python3
"""Mini-app backend DB helper — local SQLite or Turso (stdlib-only).

Env (injected by gateway when app has linked data-sources.json):
  Per linked source (alias "billing" → env key BILLING):
    PAPR_DB_{KEY}              — local SQLite path (local mode)
    PAPR_DB_{KEY}_MODE         — local|turso
    PAPR_DB_{KEY}_URL          — libsql URL (turso mode)
    PAPR_DB_{KEY}_AUTH_TOKEN   — Turso token (turso mode)
    PAPR_DB_{KEY}_ALIAS        — alias string (e.g. billing)

  Active source (backward compat — manifest sourceId / params.sourceId / legacy primary):
    PAPR_DB_MODE, APP_DB, PAPR_DB_URL, PAPR_DB_AUTH_TOKEN

Usage:
  from papr_db import connect, execute, executemany

  con = connect()              # active source (APP_DB)
  con = connect("billing")     # explicit alias — works with multiple linked DBs
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


def _col_names(cols: list[Any]) -> list[str]:
    names: list[str] = []
    for index, col in enumerate(cols):
        if isinstance(col, str):
            names.append(col)
        elif isinstance(col, dict):
            names.append(str(col.get("name", f"c{index}")))
        else:
            names.append(f"c{index}")
    return names


def _unwrap_cell(value: Any) -> Any:
    if isinstance(value, dict) and "value" in value and "type" in value:
        return value.get("value")
    return value


def _row_to_dict(names: list[str], row: Any) -> dict[str, Any]:
    if isinstance(row, dict):
        return {str(key): _unwrap_cell(val) for key, val in row.items()}
    if isinstance(row, (list, tuple)):
        return {
            name: _unwrap_cell(val) for name, val in zip(names, row, strict=False)
        }
    return {}


def _turso_error_message(first: dict[str, Any]) -> str:
    err = first.get("error")
    if isinstance(err, dict):
        return str(err.get("message") or err.get("error") or err)
    if isinstance(err, list):
        return "; ".join(str(item) for item in err)
    if err is not None:
        return str(err)
    return "Turso error"


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _parse_turso_columns(result: dict[str, Any]) -> list[str]:
    cols = result.get("columns") or result.get("cols") or []
    if not isinstance(cols, list):
        return []
    return _col_names(cols)


def _parse_turso_rows(result: dict[str, Any], names: list[str]) -> list[dict[str, Any]]:
    rows = result.get("rows") or []
    if not isinstance(rows, list):
        return []
    return [_row_to_dict(names, row) for row in rows]


def _parse_hrana_select(response: dict[str, Any]) -> list[dict[str, Any]]:
    payload = _as_dict(response)
    raw_result = payload.get("result", payload)

    if isinstance(raw_result, list):
        out: list[dict[str, Any]] = []
        for row in raw_result:
            if isinstance(row, dict):
                out.append(_row_to_dict([], row))
            elif isinstance(row, (list, tuple)):
                col_names = [f"c{index}" for index in range(len(row))]
                out.append(_row_to_dict(col_names, row))
        return out

    result = _as_dict(raw_result)
    names = _parse_turso_columns(result)
    return _parse_turso_rows(result, names)


def _parse_turso_http_select(result: dict[str, Any]) -> list[dict[str, Any]]:
    names = _parse_turso_columns(result)
    return _parse_turso_rows(result, names)


def _parse_turso_http_write(result: dict[str, Any]) -> int:
    if "rows_written" in result:
        return int(result.get("rows_written", 0))
    if "affected_row_count" in result:
        return int(result.get("affected_row_count", 0))
    return 0


def _normalize_turso_payload(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        nested = payload.get("results")
        if isinstance(nested, list):
            return nested
        if isinstance(nested, dict):
            return [nested]
        nested_result = payload.get("result")
        if isinstance(nested_result, list):
            return nested_result
        if isinstance(nested_result, dict):
            return [nested_result]
        return [payload]
    return []


def _unwrap_turso_statement(entry: Any) -> tuple[str | None, dict[str, Any]]:
    if not isinstance(entry, dict):
        return None, {}

    if entry.get("type") == "error":
        return "error", entry

    response = entry.get("response")
    if isinstance(response, dict):
        rtype = response.get("type")
        if rtype in {"execute", "rows"}:
            return "select" if rtype == "rows" else "hrana", response
        return "hrana", response

    results = entry.get("results")
    if isinstance(results, dict):
        return "http", results

    if "columns" in entry or "cols" in entry or "rows" in entry:
        return "http", entry

    return None, entry


def db_mode() -> str:
    return os.environ.get("PAPR_DB_MODE", "")


def _env_prefix_for_alias(alias: str) -> str | None:
    """Find PAPR_DB_{KEY} prefix for a linked source alias."""
    suffix = "_ALIAS"
    for key, value in os.environ.items():
        if key.startswith("PAPR_DB_") and key.endswith(suffix) and value == alias:
            return key[: -len(suffix)]
    return None


def _connect_local(path: str) -> sqlite3.Connection:
    if not path:
        raise RuntimeError("APP_DB not set — attach_database first")
    return sqlite3.connect(path)


def _connect_turso(url: str, token: str) -> "_TursoConnection":
    if not url or not token:
        raise RuntimeError("PAPR_DB_URL / PAPR_DB_AUTH_TOKEN not set")
    return _TursoConnection(url, token)


def connect(source_id: str | None = None) -> sqlite3.Connection | "_TursoConnection":
    if source_id:
        prefix = _env_prefix_for_alias(source_id)
        if not prefix:
            raise RuntimeError(
                f'No linked database with alias "{source_id}". '
                f'Linked: {os.environ.get("PAPR_LINKED_DB_ALIASES", "")}'
            )
        mode = os.environ.get(f"{prefix}_MODE", "local")
        if mode == "local":
            return _connect_local(os.environ.get(prefix, ""))
        if mode == "turso":
            return _connect_turso(
                os.environ.get(f"{prefix}_URL", ""),
                os.environ.get(f"{prefix}_AUTH_TOKEN", ""),
            )
        raise RuntimeError(f"Unknown DB mode for {source_id}: {mode}")

    mode = db_mode()
    if mode == "local":
        return _connect_local(os.environ.get("APP_DB", ""))
    if mode == "turso":
        return _connect_turso(
            os.environ.get("PAPR_DB_URL", ""),
            os.environ.get("PAPR_DB_AUTH_TOKEN", ""),
        )
    raise RuntimeError(
        "No linked database — attach_database first, or pass connect(source_id=alias)"
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


class _TursoCursor:
    """sqlite3.Cursor-compatible wrapper for cloud backends using raw cursor() API."""

    def __init__(self, conn: "_TursoConnection") -> None:
        self._conn = conn
        self._rows: list[tuple[Any, ...]] = []
        self.rowcount = -1
        self.description: list[tuple[Any, ...]] | None = None

    def execute(
        self,
        sql: str,
        params: list[Any] | tuple[Any, ...] | None = None,
    ) -> "_TursoCursor":
        args = list(params or [])
        result = self._conn.execute(sql, args)
        if isinstance(result, list):
            if result:
                names = list(result[0].keys())
                self.description = [(name, None, None, None, None, None, None) for name in names]
                self._rows = [tuple(row[name] for name in names) for row in result]
            else:
                self.description = []
                self._rows = []
            self.rowcount = len(self._rows)
        else:
            self.description = None
            self._rows = []
            self.rowcount = int(result)
        return self

    def executemany(
        self,
        sql: str,
        seq: list[list[Any] | tuple[Any, ...]],
    ) -> "_TursoCursor":
        total = 0
        for params in seq:
            total += int(self.execute(sql, params).rowcount)
        self.rowcount = total
        return self

    def fetchone(self) -> tuple[Any, ...] | None:
        if not self._rows:
            return None
        return self._rows[0]

    def fetchall(self) -> list[tuple[Any, ...]]:
        return list(self._rows)

    def close(self) -> None:
        return None


class _TursoConnection:
    """Minimal Turso/libsql HTTP client (stdlib only)."""

    def __init__(self, libsql_url: str, auth_token: str) -> None:
        self._url = _http_url(libsql_url)
        self._token = auth_token

    def cursor(self) -> _TursoCursor:
        return _TursoCursor(self)

    def commit(self) -> None:
        return None

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

        statements = _normalize_turso_payload(payload)
        if not statements:
            return 0 if not sql.strip().upper().startswith("SELECT") else []

        kind, body = _unwrap_turso_statement(statements[0])
        if kind == "error":
            raise RuntimeError(_turso_error_message(body))

        if kind == "http":
            if sql.strip().upper().startswith("SELECT"):
                return _parse_turso_http_select(body)
            return _parse_turso_http_write(body)

        if kind in {"hrana", "select"}:
            if sql.strip().upper().startswith("SELECT"):
                return _parse_hrana_select(body)
            return _parse_turso_http_write(_as_dict(body.get("result")))

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
