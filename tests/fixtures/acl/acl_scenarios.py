"""Test plan §B — row _acl helpers against a real SQLite DB, per caller.

Run: python3 tests/fixtures/acl/acl_scenarios.py   (prints PASS/FAIL per case, exit 1 on any FAIL)
"""
import importlib.util, json, os, sqlite3, sys
from pathlib import Path

HELPER = Path(__file__).resolve().parents[3] / "src/gateway/services/appRuntime/backendDbHelper.py"
spec = importlib.util.spec_from_file_location("papr_db", HELPER)
pdb = importlib.util.module_from_spec(spec); sys.modules["papr_db"] = pdb; spec.loader.exec_module(pdb)

con = sqlite3.connect(":memory:")
con.execute("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT, _acl TEXT)")
rows = [
    (1, "legacy public (NULL)", None),
    (2, "alice private", json.dumps({"alice": {"read": True, "write": True}})),
    (3, "alice shared w/ bob", json.dumps({"alice": {"read": True, "write": True}, "bob": {"read": True}})),
    (4, "alice public-read", json.dumps({"alice": {"read": True, "write": True}, "*": {"read": True}})),
    (5, "bob private", json.dumps({"bob": {"read": True, "write": True}})),
    (6, "everyone can edit", json.dumps({"*": {"read": True, "write": True}})),
]
con.executemany("INSERT INTO notes VALUES(?,?,?)", rows)

def as_user(uid):
    if uid is None: os.environ.pop("PAPR_CALLER_USER_ID", None)
    else: os.environ["PAPR_CALLER_USER_ID"] = uid

def readable(uid):
    as_user(uid); w, a = pdb.acl_read_filter()
    return sorted(r[0] for r in con.execute(f"SELECT id FROM notes WHERE {w}", a))

def writable(uid):
    as_user(uid); w, a = pdb.acl_write_filter()
    return sorted(r[0] for r in con.execute(f"SELECT id FROM notes WHERE {w}", a))

fails = 0
def check(name, got, want):
    global fails
    ok = got == want; fails += (not ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   got={got} want={want}"))

check("B1 alice reads own + shared + public + legacy", readable("alice"), [1, 2, 3, 4, 6])
check("B2 bob reads shared-with-him, not alice private", readable("bob"), [1, 3, 4, 5, 6])
check("B3 carol (stranger) sees only public", readable("carol"), [1, 4, 6])
check("B4 anonymous sees only public", readable(None), [1, 4, 6])
check("B5 alice writes only her rows (+ *.write)", writable("alice"), [2, 3, 4, 6])
check("B6 bob can't write row he can only read", writable("bob"), [5, 6])
check("B7 anonymous writes nothing", writable(None), [])
check("B8 legacy NULL rows are NOT writable by strangers", 1 in writable("carol"), False)

# Spoofing / injection on the caller id
check("B9 uid with quote is rejected (treated anonymous)", readable('alice"').__eq__(readable(None)), True)
check("B10 uid with JSON-path injection rejected", readable("x\".read') = 1 OR 1=1 --"), [1, 4, 6])
check("B11 empty uid = anonymous", readable(""), [1, 4, 6])
check("B12 uid named '*' cannot impersonate wildcard", readable("*"), [1, 4, 6])

# acl_for_caller
as_user("alice")
acl = json.loads(pdb.acl_for_caller(share_with=["bob", "bad'id"]))
check("B13 new row: owner rw, share read-only, bad id dropped", acl, {"alice": {"read": True, "write": True}, "bob": {"read": True}})
check("B14 public_read adds *.read", json.loads(pdb.acl_for_caller(public_read=True)).get("*"), {"read": True})
as_user(None)
try:
    pdb.acl_for_caller(); check("B15 anonymous insert refused", "no error", "PermissionError")
except PermissionError:
    check("B15 anonymous insert refused", "PermissionError", "PermissionError")

# Table alias form
as_user("bob"); w, a = pdb.acl_read_filter("n")
got = sorted(r[0] for r in con.execute(f"SELECT n.id FROM notes n WHERE {w}", a))
check("B16 alias filter works in joins", got, [1, 3, 4, 5, 6])

sys.exit(1 if fails else 0)
