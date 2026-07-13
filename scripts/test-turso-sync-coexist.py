#!/usr/bin/env python3
"""
Test: libsql sync while another SQLite connection holds the file open.

Simulates better-sqlite3 (gateway persistent) + libsql (background sync worker).
Uses Python sqlite3 — same WAL file locking semantics as better-sqlite3.
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

MEMORY_SERVER = os.environ.get("PAPR_MEMORY_SERVER_URL", "http://localhost:5001")
API_KEY = os.environ.get("PAPR_API_KEY")
if not API_KEY:
    print("❌ PAPR_API_KEY required (set in .env.local or env)", file=sys.stderr)
    sys.exit(1)

import httpx

LIBSQL_SCRIPT = """
import sys
import libsql_experimental as libsql
db_path, sync_url, token = sys.argv[1], sys.argv[2], sys.argv[3]
conn = libsql.connect(db_path, sync_url=sync_url, auth_token=token)
conn.sync()
conn.close()
print("SYNC_OK")
"""


def log(msg: str) -> None:
    print(msg, flush=True)


def ok(name: str) -> None:
    print(f"  ✅ {name}", flush=True)


def bad(name: str, err: str) -> None:
    print(f"  ❌ {name}: {err}", flush=True)


def fetch_token(db_name: str) -> tuple[str, str]:
    with httpx.Client(timeout=120) as client:
        r = client.post(
            f"{MEMORY_SERVER}/v1/cloud/databases/token",
            headers={"X-API-Key": API_KEY, "Content-Type": "application/json"},
            json={"database": db_name},
        )
        r.raise_for_status()
        data = r.json()
        return data["tursoUrl"], data["authToken"]


def libsql_sync(db_path: str, sync_url: str, token: str) -> None:
    result = subprocess.run(
        [sys.executable, "-c", LIBSQL_SCRIPT, db_path, sync_url, token],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())


def open_sqlite(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def setup_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            content TEXT NOT NULL
        )
        """
    )
    conn.commit()


def cleanup(path: str) -> None:
    for suffix in ("", "-wal", "-shm"):
        try:
            os.unlink(path + suffix)
        except FileNotFoundError:
            pass


def main() -> int:
    log("\n=== Turso Background Sync Worker — Coexistence Test ===\n")

    passed = 0
    failed = 0

    db_name = f"coexist-py-{int(time.time())}"
    log(f"Provisioning Turso DB: {db_name}")
    try:
        turso_url, token = fetch_token(db_name)
        ok(f"Token obtained ({turso_url[:60]}...)")
        passed += 1
    except Exception as exc:
        bad("Token obtained", str(exc))
        return 1

    tmp = tempfile.mkdtemp(prefix="papr-turso-test-")
    db_path = str(Path(tmp) / "test.db")

    # Test 1: Pull before app opens (startup pattern)
    log("\n--- Test 1: Pull on startup (before sqlite opens) ---")
    try:
        libsql_sync(db_path, turso_url, token)
        conn = open_sqlite(db_path)
        setup_schema(conn)
        conn.close()
        ok("Pull on startup works")
        passed += 1
    except Exception as exc:
        bad("Pull on startup", str(exc))
        failed += 1

    # Test 2: Push while sqlite connection is OPEN
    log("\n--- Test 2: Push while sqlite connection is OPEN ---")
    try:
        conn = open_sqlite(db_path)
        setup_schema(conn)
        conn.execute(
            "INSERT INTO messages (role, content) VALUES (?, ?)",
            ("user", "written while open"),
        )
        conn.commit()
        count_before = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]

        libsql_sync(db_path, turso_url, token)

        count_after = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        if count_after != count_before:
            raise RuntimeError(f"Row count changed: {count_before} → {count_after}")
        conn.close()
        ok(f"Push while open works ({count_after} rows)")
        passed += 1
    except Exception as exc:
        bad("Push while open", str(exc))
        failed += 1

    # Test 3: WAL checkpoint + push while open
    log("\n--- Test 3: WAL checkpoint + push while open ---")
    try:
        conn = open_sqlite(db_path)
        setup_schema(conn)
        conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
        libsql_sync(db_path, turso_url, token)
        conn.close()
        ok("Checkpoint + push while open works")
        passed += 1
    except Exception as exc:
        bad("Checkpoint + push while open", str(exc))
        failed += 1

    # Test 4: Round-trip to fresh local file
    log("\n--- Test 4: Round-trip (write → push → pull on new device) ---")
    try:
        marker = f"marker-{int(time.time())}"
        conn = open_sqlite(db_path)
        setup_schema(conn)
        conn.execute(
            "INSERT INTO messages (role, content) VALUES (?, ?)",
            ("user", marker),
        )
        conn.commit()
        conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
        conn.close()

        libsql_sync(db_path, turso_url, token)

        remote_path = str(Path(tmp) / "remote.db")
        cleanup(remote_path)
        libsql_sync(remote_path, turso_url, token)

        reader = sqlite3.connect(f"file:{remote_path}?mode=ro", uri=True)
        row = reader.execute(
            "SELECT content FROM messages WHERE content = ?", (marker,)
        ).fetchone()
        reader.close()

        if not row:
            raise RuntimeError(f"Marker '{marker}' not found on remote replica")
        ok(f"Round-trip works (found '{marker}')")
        passed += 1
    except Exception as exc:
        bad("Round-trip", str(exc))
        failed += 1

    # Test 5: Job simulation — gateway open + short job write + push
    log("\n--- Test 5: Job simulation (gateway open + job writes + push) ---")
    try:
        gateway = open_sqlite(db_path)
        setup_schema(gateway)

        job = open_sqlite(db_path)
        job.execute(
            "INSERT INTO messages (role, content) VALUES (?, ?)",
            ("assistant", "job write"),
        )
        job.commit()
        job.close()

        gateway.execute("PRAGMA wal_checkpoint(PASSIVE)")
        libsql_sync(db_path, turso_url, token)
        gateway.close()
        ok("Gateway open + job write + push works")
        passed += 1
    except Exception as exc:
        bad("Job simulation", str(exc))
        failed += 1

    # Test 6: Pull while open — does existing connection see new data?
    log("\n--- Test 6: Pull while connection open (visibility test) ---")
    try:
        # Push new data from another file to cloud
        writer_path = str(Path(tmp) / "writer.db")
        cleanup(writer_path)
        libsql_sync(writer_path, turso_url, token)
        writer = open_sqlite(writer_path)
        setup_schema(writer)
        remote_marker = f"remote-{int(time.time())}"
        writer.execute(
            "INSERT INTO messages (role, content) VALUES (?, ?)",
            ("user", remote_marker),
        )
        writer.commit()
        writer.close()
        libsql_sync(writer_path, turso_url, token)

        # Gateway has DB open — pull
        gateway = open_sqlite(db_path)
        setup_schema(gateway)
        libsql_sync(db_path, turso_url, token)

        found_open = gateway.execute(
            "SELECT content FROM messages WHERE content = ?", (remote_marker,)
        ).fetchone()

        gateway.close()
        gateway2 = open_sqlite(db_path)
        found_reopen = gateway2.execute(
            "SELECT content FROM messages WHERE content = ?", (remote_marker,)
        ).fetchone()
        gateway2.close()

        if found_open:
            ok(f"Pull while open — data visible WITHOUT reopen (found '{remote_marker}')")
        elif found_reopen:
            ok(
                f"Pull while open — data visible AFTER reopen only (found '{remote_marker}')"
            )
            log("     ℹ️  Design note: schedule pulls at startup or close/reopen connection")
        else:
            raise RuntimeError(f"Marker '{remote_marker}' not found even after reopen")
        passed += 1
    except Exception as exc:
        bad("Pull while open", str(exc))
        failed += 1

    cleanup(db_path)
    log(f"\n=== Results: {passed} passed, {failed} failed ===\n")

    if failed:
        log("Some tests failed — see above for details.\n")
        return 1

    log("✅ Background sync worker approach is viable!\n")
    log("Recommended pattern:")
    log("  • Pull: on startup (before opening better-sqlite3)")
    log("  • Push: debounced after writes (while connection open — OK)")
    log("  • Pull while running: close + reopen connection to see new data")
    log("  • Job DBs: pause push while job running\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
