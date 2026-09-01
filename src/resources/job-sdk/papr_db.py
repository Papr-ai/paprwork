"""Database access for jobs. Import with `import papr_db` — no vendoring.

WHY THIS EXISTS
---------------
A Turso replica records its sync position in `data.db-info` as a byte offset
into the WAL (`wal_fragment_no`). SQLite runs an automatic checkpoint when the
LAST connection to a database closes, and that checkpoint TRUNCATES THE WAL TO
ZERO. Measured:

    WAL bytes while connection OPEN : 12392
    WAL bytes after connection CLOSE: 0

So a job doing `sqlite3.connect(path)` → write → close destroys the frame the
sync engine still points at, and the next push fails with:

    I/O error: short read on WAL frame at offset 65952: expected 4096, got 0

This wedged a production database six times in one session and eventually
blocked every write, including from the mini-app. Scheduled jobs re-broke it on
a timer, and an *agent* job re-broke it whenever the agent rewrote its own
script — which is why the fix has to live here and not in job code.

HOW IT WORKS
------------
When PAPR_DB_*_MODE is "replica" the gateway also exports proxy credentials:

  * reads  → local file opened `mode=ro` (never takes a write lock, never
             checkpoints, so the sync engine's offset stays valid)
  * writes → POST to the gateway, which owns a long-lived connection and
             coordinates with the sync engine

"local" (unsynced) and "turso" (cloud sandbox) modes are unchanged.

USAGE
-----
    import papr_db

    con = papr_db.connect()             # active database
    con = papr_db.connect("billing")    # by linked alias

    rows = con.execute("SELECT * FROM users WHERE id=?", [uid]).fetchall()
    con.execute("INSERT INTO users (id, name) VALUES (?,?)", [uid, name])
    con.commit()

The returned object is sqlite3.Connection-shaped on purpose: existing jobs that
call `.execute()` / `.commit()` / `.fetchone()` keep working unchanged.
"""

import json
import os
import sqlite3
import urllib.error
import urllib.request

__all__ = ["connect", "query", "execute", "PaprDbError"]

_WRITE_VERBS = ("INSERT", "UPDATE", "DELETE", "REPLACE", "UPSERT")
_SCHEMA_VERBS = ("CREATE", "ALTER", "DROP")


class PaprDbError(RuntimeError):
    pass


# ── env resolution ────────────────────────────────────────────────────────────

def _prefix_for_alias(alias):
    """PAPR_DB_{KEY}_ALIAS == alias  →  PAPR_DB_{KEY}"""
    suffix = "_ALIAS"
    for key, value in os.environ.items():
        if key.startswith("PAPR_DB_") and key.endswith(suffix) and value == alias:
            return key[: -len(suffix)]
    return None


def _linked_aliases():
    out = []
    for key, value in os.environ.items():
        if key.startswith("PAPR_DB_") and key.endswith("_ALIAS"):
            out.append(value)
    return sorted(out)


def _resolve(source_id):
    """-> (mode, path, alias). source_id=None uses the active database."""
    if source_id:
        prefix = _prefix_for_alias(source_id)
        if not prefix:
            raise PaprDbError(
                'No linked database with alias "%s". Linked: %s'
                % (source_id, ", ".join(_linked_aliases()) or "(none)")
            )
        return (
            os.environ.get(prefix + "_MODE", "local"),
            os.environ.get(prefix, ""),
            source_id,
        )

    mode = os.environ.get("PAPR_DB_MODE", "")
    if not mode:
        raise PaprDbError(
            "No linked database. Set writeDbIds on the job, or pass "
            'connect("alias") for a specific linked source.'
        )
    return mode, os.environ.get("APP_DB", ""), os.environ.get("APP_DB_ALIAS", "")


# ── gateway proxy ─────────────────────────────────────────────────────────────

def _proxy_post(action, sql, params, alias=""):
    """POST to the gateway. Token → per-run proxy session; otherwise the public
    /api/db route, which uses the same adapters and the same single writer."""
    url = os.environ.get("PAPR_DB_PROXY_URL", "").strip()
    token = os.environ.get("PAPR_DB_PROXY_TOKEN", "").strip()
    app_id = os.environ.get("APP_ID", "").strip()

    payload = {"sql": sql, "params": list(params or [])}
    headers = {"Content-Type": "application/json"}

    if url and token:
        headers["Authorization"] = "Bearer " + token
        endpoint = "%s/%s" % (url.rstrip("/"), action)
    elif app_id:
        base = os.environ.get("PAPR_GATEWAY_URL", "http://127.0.0.1:18789")
        endpoint = "%s/api/db/%s" % (base.rstrip("/"), action)
        payload["appId"] = app_id
        payload["sourceId"] = alias or os.environ.get("APP_DB_ALIAS", "")
    else:
        raise PaprDbError(
            "Database is replica-managed but no gateway credentials are set "
            "(PAPR_DB_PROXY_URL/TOKEN or APP_ID). Writing directly would "
            "truncate the WAL and corrupt sync."
        )

    return _send(endpoint, payload, headers, action)


def _send(endpoint, payload, headers, action, _retried=False):
    req = urllib.request.Request(
        endpoint, data=json.dumps(payload).encode(), headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        # The job env alias is the database LABEL ("linkedin-outreach"); the
        # app's sourceId is the ATTACHMENT alias ("outreach"). They are
        # different namespaces and often differ. The gateway's 404 names the
        # aliases it does accept, so adopt the single one it offers rather
        # than failing a write that is otherwise correct.
        if e.code == 404 and not _retried and "Available:" in body:
            available = [
                a.strip() for a in body.split("Available:")[1]
                .rstrip("\"}").split(",") if a.strip()
            ]
            if len(available) == 1:
                payload["sourceId"] = available[0]
                return _send(endpoint, payload, headers, action, _retried=True)
        raise PaprDbError(
            "gateway %s failed (%s): %s" % (action, e.code, body[:300])
        )
    except urllib.error.URLError as e:
        raise PaprDbError(
            "gateway unreachable for %s: %s. Is the desktop app running?"
            % (action, e)
        )


# ── connection shims ──────────────────────────────────────────────────────────

class _Cursor:
    """Enough of sqlite3.Cursor for the common job patterns."""

    def __init__(self, rows):
        self._rows = rows

    def __iter__(self):
        return iter(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


class ReplicaConnection:
    """Reads local read-only; writes through the gateway.

    Deliberately sqlite3.Connection-shaped so jobs written against raw sqlite3
    keep working after this module is swapped in.
    """

    def __init__(self, path, alias=""):
        if not path:
            raise PaprDbError("No database path in environment")
        self._path = path
        self._alias = alias
        self._last = None
        self._read = sqlite3.connect("file:%s?mode=ro" % path, uri=True)
        self._read.row_factory = sqlite3.Row

    def execute(self, sql, params=None):
        verb = sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""
        if verb in _SCHEMA_VERBS:
            raise PaprDbError(
                "Schema changes are not allowed from a job. Write a migration "
                "under data/databases/<slug>/migrations/ and apply it with "
                "papr_db_apply_migration."
            )
        if verb in _WRITE_VERBS:
            _proxy_post("write", sql, params, self._alias)
            self._last = _Cursor([])
        else:
            self._last = _Cursor(self._read.execute(sql, params or []).fetchall())
        return self._last

    def executemany(self, sql, seq_of_params):
        for params in seq_of_params:
            self.execute(sql, params)
        return _Cursor([])

    # sqlite3 code often does `cur = con.cursor()` then `cur.execute(...)`
    # followed by `cur.fetchall()`. Supporting that shape here means existing
    # jobs (and agent-written scripts, which follow the sqlite3 idiom) port
    # over by changing only the connect call.
    def cursor(self):
        return self

    def fetchone(self):
        return self._last.fetchone() if self._last else None

    def fetchall(self):
        return self._last.fetchall() if self._last else []

    def commit(self):
        """No-op: gateway writes commit themselves.

        Kept so existing call sites read naturally and transaction structure
        does not have to change.
        """

    def rollback(self):
        raise PaprDbError(
            "rollback is not supported for replica databases — each write is "
            "committed by the gateway as it is issued."
        )

    def close(self):
        self._read.close()

    @property
    def row_factory(self):
        return self._read.row_factory

    @row_factory.setter
    def row_factory(self, value):
        # Accepted for API compatibility; reads always return sqlite3.Row.
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def is_replica_file(path):
    """True when a Turso sync engine owns this file's WAL.

    Detected from the sidecar rather than trusting PAPR_DB_*_MODE, because the
    env is written by the executor: an older desktop build still exports
    "local" for a replica database, and taking that at face value opens a raw
    write handle and truncates the WAL. Sidecar detection fails safe across
    executor versions.
    """
    return bool(path) and os.path.exists(path + "-info")


def connect(source_id=None):
    """Open the active database, or a linked one by alias."""
    mode, path, alias = _resolve(source_id)

    if mode == "replica" or is_replica_file(path):
        return ReplicaConnection(path, alias)

    if mode == "turso":
        raise PaprDbError(
            "turso mode is handled by the cloud runtime, not papr_db in jobs"
        )

    if not path:
        raise PaprDbError("No database path in environment (APP_DB / PAPR_DB_*)")
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    return con


def query(sql, params=None, source_id=None):
    """One-shot read returning a list of dicts."""
    con = connect(source_id)
    try:
        return [dict(r) for r in con.execute(sql, params or []).fetchall()]
    finally:
        con.close()


def execute(sql, params=None, source_id=None):
    """One-shot write."""
    con = connect(source_id)
    try:
        con.execute(sql, params or [])
        con.commit()
    finally:
        con.close()
