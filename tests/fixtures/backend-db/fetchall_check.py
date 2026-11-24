"""con.execute(...).fetchall() must work on proxy and Turso connections (sqlite3 idiom)."""
import sys

sys.path.insert(0, sys.argv[1])
import papr_db as h  # noqa: E402

ROWS = [{"id": 1, "name": "Milk"}, {"id": 2, "name": "Eggs"}]

proxy = h._ProxyConnection("http://127.0.0.1:1", "t")


def fake_post(route, sql, params):
    if route == "query":
        return {"rows": ROWS, "count": len(ROWS)}
    proxy.lastrowid = 7
    return {"changes": 1, "lastInsertRowid": 7}


proxy._post = fake_post

turso = h._TursoConnection("libsql://x.turso.io", "t")


def fake_raw(sql, params=None):
    if h._sql_returns_rows(sql) or not h._sql_is_write(sql):
        return [dict(r) for r in ROWS]
    turso.lastrowid = 7
    return 1


turso._execute_raw = fake_raw

for con in (proxy, turso):
    rows = con.execute("SELECT id, name FROM items").fetchall()
    assert [r["name"] for r in rows] == ["Milk", "Eggs"], rows
    assert rows[0][1] == "Milk" and rows[0]["id"] == 1
    assert con.execute("SELECT id, name FROM items").fetchone()["name"] == "Milk"
    assert len(con.execute("SELECT id FROM items")) == 2  # still a list
    w = con.execute("INSERT INTO items (name) VALUES (?)", ["Bread"])
    assert w == 1 and w.rowcount == 1 and w.lastrowid == 7 and w.fetchall() == []
    # query()/write()/execute() helpers unchanged
    assert h.query(con, "SELECT id FROM items").count == 2
    assert h.write(con, "INSERT INTO items (name) VALUES (?)", ["x"]).changes == 1
    assert h.execute(con, "SELECT id FROM items")[1]["name"] == "Eggs"

    # sqlite3-style iteration: values, so zip/unpack idioms work
    cols = ["id", "name"]
    zipped = [dict(zip(cols, r)) for r in con.execute("SELECT id, name FROM items").fetchall()]
    assert zipped == ROWS, zipped
    rid, rname = con.execute("SELECT id, name FROM items").fetchone()
    assert (rid, rname) == (1, "Milk")
    row = con.execute("SELECT id, name FROM items").fetchone()
    assert dict(row) == ROWS[0] and {**row} == ROWS[0] and list(row.keys()) == cols
    import json as _json
    assert _json.loads(_json.dumps(row)) == ROWS[0]

print("fetchall ok")
