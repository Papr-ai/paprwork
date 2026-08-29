#!/usr/bin/env python3
"""Mini-app backend DB helper — Papr /api/db contract (local, Turso, or gateway proxy).

Env (injected by gateway when app has linked data-sources.json):
  Preferred (backend subprocess): proxy via same path as /api/db/*
    PAPR_DB_MODE=proxy
    PAPR_DB_PROXY_URL          — http://127.0.0.1:<port>/internal/backend-db
    PAPR_DB_PROXY_TOKEN        — short-lived Bearer token

  Legacy direct (fallback when proxy not set):
    PAPR_DB_MODE               — local|turso
    APP_DB / PAPR_DB_URL / PAPR_DB_AUTH_TOKEN

Usage (preferred — matches POST /api/db/query and /api/db/write):
  from papr_db import connect, query, write

  con = connect()              # or connect("billing")
  rows = query(con, "SELECT name FROM items WHERE id = ?", [1])
  result = write(con, "INSERT INTO items (name) VALUES (?)", ["hello"])
  # result.changes, result.last_insert_rowid
  rows = query(con, "INSERT INTO items (name) VALUES (?) RETURNING *", ["hello"])
  con.close()

Never use sqlite3.connect(APP_DB) — cloud has no local file.
cursor() exists for legacy handlers only; prefer query()/write().
"""
from __future__ import annotations

import json
import os
import sqlite3
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Union


@dataclass(frozen=True)
class QueryResult:
    rows: list[dict[str, Any]]
    count: int


@dataclass(frozen=True)
class WriteResult:
    changes: int
    last_insert_rowid: int | None = None


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


def _parse_turso_last_insert_rowid(result: dict[str, Any]) -> int | None:
    raw = result.get("last_insert_rowid")
    if raw is None:
        return None
    return int(raw)


def _parse_turso_http_write(result: dict[str, Any]) -> tuple[int, int | None]:
    if "rows_written" in result:
        return int(result.get("rows_written", 0)), _parse_turso_last_insert_rowid(result)
    if "affected_row_count" in result:
        return int(result.get("affected_row_count", 0)), _parse_turso_last_insert_rowid(result)
    if "changes" in result:
        return int(result.get("changes", 0)), _parse_turso_last_insert_rowid(result)
    return 0, _parse_turso_last_insert_rowid(result)


def _sql_returns_rows(sql: str) -> bool:
    normalized = " ".join(sql.strip().upper().split())
    if normalized.startswith(("SELECT", "WITH", "PRAGMA")):
        return True
    return " RETURNING " in f" {normalized} "


def _sql_is_write(sql: str) -> bool:
    normalized = " ".join(sql.strip().upper().split())
    return normalized.startswith(("INSERT", "UPDATE", "DELETE", "REPLACE", "UPSERT"))


def _turso_body_has_rowset(body: dict[str, Any]) -> bool:
    if _parse_turso_columns(body):
        return True
    rows = body.get("rows")
    return isinstance(rows, list) and len(rows) > 0


def _parse_turso_execute_body(body: dict[str, Any]) -> list[dict[str, Any]] | tuple[int, int | None]:
    if _turso_body_has_rowset(body):
        return _parse_turso_http_select(body)
    return _parse_turso_http_write(body)


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


def _connect_proxy() -> "_ProxyConnection":
    url = os.environ.get("PAPR_DB_PROXY_URL", "").strip()
    token = os.environ.get("PAPR_DB_PROXY_TOKEN", "").strip()
    if not url or not token:
        raise RuntimeError("PAPR_DB_PROXY_URL / PAPR_DB_PROXY_TOKEN not set")
    return _ProxyConnection(url, token)


def connect(
    source_id: str | None = None,
) -> sqlite3.Connection | "_TursoConnection" | "_ProxyConnection":
    if db_mode() == "proxy":
        return _connect_proxy()

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


Connection = Union[sqlite3.Connection, "_TursoConnection", "_ProxyConnection"]


def query(
    con: Connection,
    sql: str,
    params: list[Any] | tuple[Any, ...] | None = None,
) -> QueryResult:
    args = list(params or [])
    if isinstance(con, sqlite3.Connection):
        cur = con.cursor()
        cur.execute(sql, args)
        cols = [d[0] for d in cur.description or []]
        rows = [dict(zip(cols, row)) for row in cur.fetchall()]
        return QueryResult(rows=rows, count=len(rows))

    if isinstance(con, _ProxyConnection):
        payload = con._post("query", sql, args)
        rows = payload.get("rows") or []
        if not isinstance(rows, list):
            rows = []
        typed_rows = [row for row in rows if isinstance(row, dict)]
        count = int(payload.get("count", len(typed_rows)))
        return QueryResult(rows=typed_rows, count=count)

    result = con.execute(sql, args)
    if not isinstance(result, list):
        raise RuntimeError("query() requires SELECT, WITH, or INSERT … RETURNING SQL")
    return QueryResult(rows=result, count=len(result))


def write(
    con: Connection,
    sql: str,
    params: list[Any] | tuple[Any, ...] | None = None,
) -> WriteResult:
    args = list(params or [])
    if _sql_returns_rows(sql):
        raise RuntimeError("write() does not support RETURNING — use query()")
    if not _sql_is_write(sql):
        raise RuntimeError("write() requires INSERT, UPDATE, DELETE, REPLACE, or UPSERT SQL")

    if isinstance(con, sqlite3.Connection):
        cur = con.cursor()
        cur.execute(sql, args)
        if _sql_returns_rows(sql) or (cur.description and len(cur.description) > 0):
            raise RuntimeError(
                "write() received a row-returning statement — use query() for RETURNING"
            )
        con.commit()
        last_id = cur.lastrowid
        return WriteResult(changes=cur.rowcount, last_insert_rowid=last_id if last_id else None)

    if isinstance(con, _ProxyConnection):
        payload = con._post("write", sql, args)
        last_id = payload.get("lastInsertRowid")
        return WriteResult(
            changes=int(payload.get("changes", 0)),
            last_insert_rowid=int(last_id) if last_id is not None else None,
        )

    result = con.execute(sql, args)
    if isinstance(result, list):
        raise RuntimeError(
            "write() received a row-returning statement — use query() for RETURNING"
        )
    last_id = con.lastrowid
    return WriteResult(changes=int(result), last_insert_rowid=last_id)


def execute(
    con: Connection,
    sql: str,
    params: list[Any] | tuple[Any, ...] | None = None,
) -> list[dict[str, Any]] | int:
    """Legacy helper — prefer query() / write()."""
    if _sql_returns_rows(sql) or not _sql_is_write(sql):
        return query(con, sql, params).rows
    return write(con, sql, params).changes


def executemany(
    con: Connection,
    sql: str,
    seq: list[list[Any] | tuple[Any, ...]],
) -> int:
    total = 0
    for params in seq:
        total += write(con, sql, list(params)).changes
    return total


class _ProxyConnection:
    """Loopback client for gateway /internal/backend-db (same rules as /api/db/*)."""

    def __init__(self, base_url: str, token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self.lastrowid: int | None = None

    def _post(self, route: str, sql: str, params: list[Any]) -> dict[str, Any]:
        body = json.dumps({"sql": sql, "params": params}).encode("utf-8")
        req = urllib.request.Request(
            f"{self._base_url}/{route}",
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
            raise RuntimeError(f"Backend DB proxy HTTP {exc.code}: {detail}") from exc
        if not isinstance(payload, dict):
            raise RuntimeError("Backend DB proxy returned invalid JSON")
        if route == "write":
            last_id = payload.get("lastInsertRowid")
            self.lastrowid = int(last_id) if last_id is not None else None
        return payload

    def cursor(self) -> "_TursoCursor":
        return _TursoCursor(self)

    def commit(self) -> None:
        return None

    def execute(
        self,
        sql: str,
        params: list[Any] | None = None,
    ) -> list[dict[str, Any]] | int:
        return execute(self, sql, params)

    def close(self) -> None:
        return None


class _TursoCursor:
    """Legacy sqlite3.Cursor shim — prefer query()/write()."""

    def __init__(self, conn: _TursoConnection | _ProxyConnection) -> None:
        self._conn = conn
        self._rows: list[tuple[Any, ...]] = []
        self.rowcount = -1
        self.lastrowid: int | None = None
        self.description: list[tuple[Any, ...]] | None = None

    def execute(
        self,
        sql: str,
        params: list[Any] | tuple[Any, ...] | None = None,
    ) -> "_TursoCursor":
        args = list(params or [])
        if _sql_returns_rows(sql) or not _sql_is_write(sql):
            result = query(self._conn, sql, args)
            if result.rows:
                names = list(result.rows[0].keys())
                self.description = [(name, None, None, None, None, None, None) for name in names]
                self._rows = [tuple(row[name] for name in names) for row in result.rows]
            else:
                self.description = []
                self._rows = []
            self.rowcount = result.count
        else:
            write_result = write(self._conn, sql, args)
            self.description = None
            self._rows = []
            self.rowcount = write_result.changes
        self.lastrowid = self._conn.lastrowid
        return self

    def executemany(
        self,
        sql: str,
        seq: list[list[Any] | tuple[Any, ...]],
    ) -> "_TursoCursor":
        total = 0
        for params in seq:
            total += write(self._conn, sql, list(params)).changes
        self.rowcount = total
        self.lastrowid = self._conn.lastrowid
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
    """Direct Turso HTTP client (fallback when proxy env is not set)."""

    def __init__(self, libsql_url: str, auth_token: str) -> None:
        self._url = _http_url(libsql_url)
        self._token = auth_token
        self.lastrowid: int | None = None

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
            return [] if _sql_returns_rows(sql) else 0

        kind, body = _unwrap_turso_statement(statements[0])
        if kind == "error":
            raise RuntimeError(_turso_error_message(body))

        if kind == "http":
            parsed = _parse_turso_execute_body(body)
            if isinstance(parsed, list):
                self.lastrowid = _parse_turso_last_insert_rowid(body)
                return parsed
            rowcount, lastrowid = parsed
            self.lastrowid = lastrowid
            return rowcount

        if kind in {"hrana", "select"}:
            result_body = _as_dict(body.get("result"))
            if kind == "select" or _turso_body_has_rowset(result_body):
                self.lastrowid = _parse_turso_last_insert_rowid(result_body)
                return _parse_hrana_select(body)
            parsed = _parse_turso_execute_body(result_body)
            if isinstance(parsed, list):
                self.lastrowid = _parse_turso_last_insert_rowid(result_body)
                return parsed
            rowcount, lastrowid = parsed
            self.lastrowid = lastrowid
            return rowcount

        self.lastrowid = None
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
