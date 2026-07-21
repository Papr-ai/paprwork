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
