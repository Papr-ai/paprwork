import importlib.util, os, sqlite3, sys, json
sys.path.insert(0, sys.argv[1]); import papr_db as h
con = sqlite3.connect(":memory:")
con.execute("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT, _acl TEXT)")
def as_user(u):
    if u: os.environ["PAPR_CALLER_USER_ID"]=u
    else: os.environ.pop("PAPR_CALLER_USER_ID", None)
as_user("alice"); con.execute("INSERT INTO notes(body,_acl) VALUES('a-private',?)",[h.acl_for_caller()])
con.execute("INSERT INTO notes(body,_acl) VALUES('a-public',?)",[h.acl_for_caller(public_read=True)])
con.execute("INSERT INTO notes(body,_acl) VALUES('a-shared-bob',?)",[h.acl_for_caller(share_with=["bob"])])
con.execute("INSERT INTO notes(body,_acl) VALUES('legacy',NULL)")
def read(u):
    as_user(u); w,a=h.acl_read_filter(); return sorted(r[0] for r in con.execute(f"SELECT body FROM notes WHERE {w}",a))
def writable(u):
    as_user(u); w,a=h.acl_write_filter(); return sorted(r[0] for r in con.execute(f"SELECT body FROM notes WHERE {w}",a))
assert read("alice")==["a-private","a-public","a-shared-bob","legacy"], read("alice")
assert read("bob")==["a-public","a-shared-bob","legacy"], read("bob")
assert read("eve")==["a-public","legacy"], read("eve")
assert read(None)==["a-public","legacy"], read(None)
assert writable("alice")==["a-private","a-public","a-shared-bob"]
assert writable("bob")==[] and writable(None)==[]
as_user('x" OR 1=1 --'); assert h.caller_id()=="" 
as_user(None)
try: h.acl_for_caller(); raise SystemExit("expected PermissionError")
except PermissionError: pass
w,a=h.acl_read_filter("n"); assert "n._acl" in w
print("python acl ok")
