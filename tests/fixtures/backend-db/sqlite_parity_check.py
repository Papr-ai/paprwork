"""Run common sqlite3 handler idioms against real sqlite3 and through both Papr
helpers (job SDK papr_db + backend papr_db). Results must match sqlite3.

argv[1] = dir containing backend helper as papr_db.py
argv[2] = job-sdk dir (papr_db.py + papr_sqlite_compat.py)
"""
import importlib.util
import json
import sqlite3
import sys

BACKEND_DIR, JOB_SDK_DIR = sys.argv[1], sys.argv[2]
sys.path.insert(0, JOB_SDK_DIR)  # papr_sqlite_compat, as PYTHONPATH does at runtime


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    # @dataclass resolves the module via sys.modules (None on newer Pythons otherwise).
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


backend = load("backend_papr_db", f"{BACKEND_DIR}/papr_db.py")
job = load("job_papr_db", f"{JOB_SDK_DIR}/papr_db.py")

SCHEMA = "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER, checked INTEGER)"
SEED = [("Milk", 1, 0), ("Eggs", 12, 1), ("Bread", 2, 0)]


def real_db():
    con = sqlite3.connect(":memory:")
    con.execute(SCHEMA)
    con.executemany("INSERT INTO items (name, qty, checked) VALUES (?, ?, ?)", SEED)
    con.commit()
    return con


def gateway_for(store):
    """Simulates the gateway's JSON contract over a real sqlite db."""
    store.row_factory = sqlite3.Row

    def handle(route, sql, params):
        cur = store.execute(sql, params or [])
        if route == "query":
            rows = [dict(r) for r in cur.fetchall()]
            return {"rows": rows, "count": len(rows)}
        store.commit()
        return {"changes": cur.rowcount, "lastInsertRowid": cur.lastrowid}

    return handle


def backend_proxy():
    g = gateway_for(real_db())
    con = backend._ProxyConnection("http://127.0.0.1:1", "t")

    def post(route, sql, params):
        out = g(route, sql, params)
        if route == "write":
            con.lastrowid = out["lastInsertRowid"]
        return out

    con._post = post
    return con


def backend_turso():
    store = real_db()
    store.row_factory = sqlite3.Row
    con = backend._TursoConnection("libsql://x.turso.io", "t")

    def raw(sql, params=None):
        cur = store.execute(sql, params or [])
        if backend._sql_returns_rows(sql) or not backend._sql_is_write(sql):
            return [dict(r) for r in cur.fetchall()]
        store.commit()
        con.lastrowid = cur.lastrowid
        return cur.rowcount

    con._execute_raw = raw
    return con


def job_replica():
    g = gateway_for(real_db())
    job._has_gateway_credentials = lambda: True
    job._proxy_post = lambda action, sql, params, alias="": g(action, sql, params)
    return job.ReplicaConnection("/replica.db")


def reference():
    con = real_db()
    con.row_factory = sqlite3.Row
    return con


# Each idiom takes a connection and returns plain data to compare.
SEL = "SELECT id, name, qty, checked FROM items ORDER BY id"
IDIOMS = {
    "fetchall_zip": lambda c: [dict(zip(["id", "name", "qty", "checked"], r)) for r in c.execute(SEL).fetchall()],
    "description_zip": lambda c: (lambda cur: [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()])(c.execute(SEL)),
    "dict_row": lambda c: [dict(r) for r in c.execute(SEL).fetchall()],
    "by_name": lambda c: [r["name"] for r in c.execute(SEL)],
    "by_index": lambda c: [(r[0], r[1]) for r in c.execute(SEL).fetchall()],
    "unpack": lambda c: [f"{name}x{qty}" for _id, name, qty, _ck in c.execute(SEL).fetchall()],
    "tuple_row": lambda c: [tuple(r) for r in c.execute(SEL).fetchall()],
    "keys": lambda c: list(c.execute(SEL).fetchone().keys()),
    "fetchone": lambda c: dict(c.execute("SELECT name FROM items WHERE id = ?", [2]).fetchone()),
    "fetchone_none": lambda c: c.execute("SELECT name FROM items WHERE id = ?", [99]).fetchone(),
    "fetchone_scalar": lambda c: c.execute("SELECT COUNT(*) AS n FROM items").fetchone()[0],
    "fetchone_then_all": lambda c: (lambda cur: (cur.fetchone()["name"], [r["name"] for r in cur.fetchall()]))(c.execute(SEL)),
    "fetchmany": lambda c: [r["name"] for r in c.execute(SEL).fetchmany(2)],
    "cursor_execute": lambda c: (lambda cur: (cur.execute(SEL), [r["name"] for r in cur.fetchall()])[1])(c.cursor()),
    "insert_lastrowid": lambda c: c.execute("INSERT INTO items (name, qty, checked) VALUES (?, ?, ?)", ["Jam", 1, 0]).lastrowid,
    "update_rowcount": lambda c: c.execute("UPDATE items SET checked = 1 WHERE checked = 0").rowcount,
    "json_rows": lambda c: json.loads(json.dumps([dict(r) for r in c.execute(SEL).fetchall()])),
    "with_block": lambda c: (lambda: [r["name"] for r in c.execute(SEL)])(),
}

TARGETS = {
    "backend proxy": backend_proxy,
    "backend turso": backend_turso,
    "job replica": job_replica,
}

failures = []
for idiom, fn in IDIOMS.items():
    expected = fn(reference())
    for target, make in TARGETS.items():
        try:
            got = fn(make())
        except Exception as exc:  # noqa: BLE001
            got = f"{type(exc).__name__}: {exc}"
        if got != expected:
            failures.append(f"{idiom} [{target}]: expected {expected!r}, got {got!r}")

if failures:
    print("\n".join(failures))
    sys.exit(1)
print(f"parity ok: {len(IDIOMS)} idioms x {len(TARGETS)} targets")
