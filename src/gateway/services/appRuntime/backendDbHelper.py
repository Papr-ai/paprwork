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

# Bump when this helper gains behaviour app backends depend on.
# Vendored copies in <app>/backend/papr_db.py are refreshed by the gateway
# when their PAPR_DB_HELPER_VERSION is lower (or absent). Copies at or above
# this number are left alone, so hand-edited helpers are never clobbered.
#   1 = pre-proxy (writes directly to the SQLite file — wedges replica sync)
#   2 = proxy support (PAPR_DB_MODE=proxy), query()/write(), _ProxyConnection
#   3 = proxy passes sourceId (required when app has 2+ linked databases)
#   4 = row ACL helpers: caller_id(), acl_read_filter(), acl_write_filter(), acl_for_caller()
#   5 = role/team principals in `_acl` (caller_role(), caller_principals()) +
#       acl_segment_filter() for membership-scoped rows (standups, projects, …)
PAPR_DB_HELPER_VERSION = 5


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


def _default_source_id() -> str | None:
    """Alias to use when a handler calls connect() with no argument.

    Only meaningful when exactly one database is linked — with several, the
    gateway requires an explicit alias and guessing would silently read the
    wrong database."""
    active = (os.environ.get("PAPR_ACTIVE_SOURCE_ID", "") or "").strip()
    if active:
        return active
    aliases = [
        a.strip()
        for a in (os.environ.get("PAPR_LINKED_DB_ALIASES", "") or "").split(",")
        if a.strip()
    ]
    return aliases[0] if len(aliases) == 1 else None


def _connect_proxy(source_id: str | None = None) -> "_ProxyConnection":
    url = os.environ.get("PAPR_DB_PROXY_URL", "").strip()
    token = os.environ.get("PAPR_DB_PROXY_TOKEN", "").strip()
    if not url or not token:
        raise RuntimeError("PAPR_DB_PROXY_URL / PAPR_DB_PROXY_TOKEN not set")
    return _ProxyConnection(url, token, source_id or _default_source_id())


def connect(
    source_id: str | None = None,
) -> sqlite3.Connection | "_TursoConnection" | "_ProxyConnection":
    # Pass the alias through — the gateway needs it to pick a database when
    # the app has more than one linked source.
    if db_mode() == "proxy":
        return _connect_proxy(source_id)

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

    def __init__(self, base_url: str, token: str, source_id: str | None = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        # Which linked database this connection targets. The gateway rejects
        # /internal/backend-db with HTTP 400 when an app has more than one
        # linked database and no sourceId is supplied — connect("sync") must
        # forward the alias as sourceId on every query/write.
        self._source_id = source_id
        self.lastrowid: int | None = None

    def _post(self, route: str, sql: str, params: list[Any]) -> dict[str, Any]:
        payload_body: dict[str, Any] = {"sql": sql, "params": params}
        if self._source_id:
            payload_body["sourceId"] = self._source_id
        body = json.dumps(payload_body).encode("utf-8")
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


# ── Row ACL (private tables) ───────────────────────────────────────────────
# Tables the app declares private cannot be queried from the browser (the
# cloud host refuses raw /api/db/* SQL on them for everyone but the owner).
# Backend actions are the only path. Each row carries an `_acl` JSON column,
# Parse-style:
#
#   {"*": {"read": true}, "<userId>": {"read": true, "write": true}}
#
# NULL `_acl` = public read (legacy rows / default). Use the helpers:
#
#   where, args = acl_read_filter()          # acl_read_filter("n") for an alias
#   rows = query(con, f"SELECT * FROM notes WHERE {where}", args).rows
#   w, wa = acl_write_filter()
#   write(con, f"UPDATE notes SET body=? WHERE id=? AND {w}", [body, note_id, *wa])
#   write(con, "INSERT INTO notes(body, _acl) VALUES (?, ?)", [body, acl_for_caller()])
#
# Besides user ids, `_acl` keys may be group principals the server resolves
# for the verified caller (never from params):
#   "role:viewer" | "role:contributor" | "role:maintainer" | "role:admin"
#       app share role, hierarchical — "role:contributor" also admits
#       maintainers and admins (PAPR_CALLER_ROLE)
#   "team"   members of the publisher's workspace team (PAPR_CALLER_TEAM_MEMBER)
#
#   acl_for_caller(min_read_role="contributor", team_read=True)
#
# Rows scoped by membership in another table (a standup, a project) use a
# segment filter instead of per-row lists — membership changes need no rewrite:
#
#   w, a = acl_segment_filter("standup_id", "standup_participants", "standup_id",
#                             "external_user_id", active_column="active")
#   rows = query(con, f"SELECT * FROM topics WHERE {w}", a)
#
# Reading every row on purpose (admin report, aggregate)? Put the marker
#   # acl: all-rows
# in the handler so validate_app knows it is intentional.

import json as _json
import re as _re

_USER_ID_RE = _re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def caller_id() -> str:
    """Verified signed-in caller (server-injected). Empty string when anonymous."""
    uid = os.environ.get("PAPR_CALLER_USER_ID", "").strip()
    return uid if _USER_ID_RE.match(uid) else ""


ROLE_ORDER = ("viewer", "contributor", "maintainer", "admin")
TEAM_PRINCIPAL = "team"
_IDENT_RE = _re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


def caller_role() -> str:
    """Caller's app share role (viewer|contributor|maintainer|admin), '' when unknown/anonymous."""
    if not caller_id():
        return ""
    role = os.environ.get("PAPR_CALLER_ROLE", "").strip().lower()
    return role if role in ROLE_ORDER else ""


def caller_is_team_member() -> bool:
    """True when the verified caller belongs to the publisher's workspace team."""
    return bool(caller_id()) and os.environ.get("PAPR_CALLER_TEAM_MEMBER", "") == "1"


def caller_principals() -> list[str]:
    """Every `_acl` key that admits the caller: user id, role:* (hierarchical), team."""
    uid = caller_id()
    if not uid:
        return []
    out = [uid]
    role = caller_role()
    if role:
        out += [f"role:{r}" for r in ROLE_ORDER[: ROLE_ORDER.index(role) + 1]]
    if caller_is_team_member():
        out.append(TEAM_PRINCIPAL)
    return out


def _acl_path(principal: str, perm: str) -> str:
    return f'$."{principal}".{perm}'


def _principal_clauses(p: str, perm: str) -> tuple[list[str], list[Any]]:
    parts: list[str] = []
    args: list[Any] = []
    for principal in caller_principals():
        parts.append(f"json_extract({p}_acl, ?) = 1")
        args.append(_acl_path(principal, perm))
    return parts, args


def acl_read_filter(alias: str = "") -> tuple[str, list[Any]]:
    """WHERE fragment: rows the caller may read (own/granted/role/team + public)."""
    p = f"{alias}." if alias else ""
    parts = [f"{p}_acl IS NULL", f"json_extract({p}_acl, '$.\"*\".read') = 1"]
    extra, args = _principal_clauses(p, "read")
    return "(" + " OR ".join(parts + extra) + ")", args


def acl_write_filter(alias: str = "") -> tuple[str, list[Any]]:
    """WHERE fragment: rows the caller may update/delete. Anonymous → none."""
    p = f"{alias}." if alias else ""
    if not caller_id():
        return "0", []
    parts, args = _principal_clauses(p, "write")
    parts.append(f"json_extract({p}_acl, '$.\"*\".write') = 1")
    return "(" + " OR ".join(parts) + ")", args


def _check_role(role: str | None, name: str) -> str | None:
    if role is None:
        return None
    r = role.strip().lower()
    if r not in ROLE_ORDER:
        raise ValueError(f"{name} must be one of {', '.join(ROLE_ORDER)}")
    return r


def acl_for_caller(
    public_read: bool = False,
    share_with: list[str] | None = None,
    *,
    min_read_role: str | None = None,
    min_write_role: str | None = None,
    team_read: bool = False,
    team_write: bool = False,
) -> str:
    """`_acl` JSON for a new row owned by the caller. Raises when anonymous.

    min_read_role / min_write_role grant every caller at or above that app role;
    team_read / team_write grant the publisher's workspace team.
    """
    uid = caller_id()
    if not uid:
        raise PermissionError("Sign-in required to create rows in a private table")
    acl: dict[str, dict[str, bool]] = {uid: {"read": True, "write": True}}
    for other in share_with or []:
        if _USER_ID_RE.match(other or ""):
            acl.setdefault(other, {})["read"] = True
    read_role = _check_role(min_read_role, "min_read_role")
    write_role = _check_role(min_write_role, "min_write_role")
    if read_role:
        acl.setdefault(f"role:{read_role}", {})["read"] = True
    if write_role:
        acl.setdefault(f"role:{write_role}", {}).update({"read": True, "write": True})
    if team_read or team_write:
        acl.setdefault(TEAM_PRINCIPAL, {})["read"] = True
        if team_write:
            acl[TEAM_PRINCIPAL]["write"] = True
    if public_read:
        acl["*"] = {"read": True}
    return _json.dumps(acl, separators=(",", ":"), sort_keys=True)


def acl_segment_filter(
    column: str,
    members_table: str,
    segment_column: str,
    user_column: str = "external_user_id",
    *,
    alias: str = "",
    active_column: str | None = None,
    admin_sees_all: bool = False,
) -> tuple[str, list[Any]]:
    """WHERE fragment: rows whose `column` is a segment the caller belongs to.

    Membership lives in `members_table` (segment_column, user_column[, active_column]),
    so adding/removing a member needs no per-row rewrite. Anonymous → no rows.
    admin_sees_all=True lets app admins (publisher + admin grants) read every segment.
    """
    for ident in (column, members_table, segment_column, user_column, active_column, alias):
        if ident and not _IDENT_RE.match(ident):
            raise ValueError(f"Invalid identifier for acl_segment_filter: {ident!r}")
    uid = caller_id()
    if not uid:
        return "0", []
    if admin_sees_all and caller_role() == "admin":
        return "1", []
    p = f"{alias}." if alias else ""
    active = f" AND {active_column} = 1" if active_column else ""
    return (
        f"{p}{column} IN (SELECT {segment_column} FROM {members_table} "
        f"WHERE {user_column} = ?{active})",
        [uid],
    )
