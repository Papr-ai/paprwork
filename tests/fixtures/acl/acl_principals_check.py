"""Role / team principals + segment filter, against the real helper and SQLite."""
import json, os, sqlite3, sys
sys.path.insert(0, sys.argv[1]); import papr_db as h

def as_caller(uid, role=None, team=False):
    for k in ("PAPR_CALLER_USER_ID", "PAPR_CALLER_ROLE", "PAPR_CALLER_TEAM_MEMBER"):
        os.environ.pop(k, None)
    if uid: os.environ["PAPR_CALLER_USER_ID"] = uid
    if role: os.environ["PAPR_CALLER_ROLE"] = role
    if team: os.environ["PAPR_CALLER_TEAM_MEMBER"] = "1"

con = sqlite3.connect(":memory:")
con.execute("CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT, _acl TEXT)")
as_caller("pub", "admin", True)
con.execute("INSERT INTO docs(body,_acl) VALUES('owner-only',?)", [h.acl_for_caller()])
con.execute("INSERT INTO docs(body,_acl) VALUES('contrib-read',?)", [h.acl_for_caller(min_read_role="contributor")])
con.execute("INSERT INTO docs(body,_acl) VALUES('maint-write',?)", [h.acl_for_caller(min_write_role="maintainer")])
con.execute("INSERT INTO docs(body,_acl) VALUES('team-read',?)", [h.acl_for_caller(team_read=True)])
con.execute("INSERT INTO docs(body,_acl) VALUES('team-write',?)", [h.acl_for_caller(team_write=True)])

def read(*a, **k):
    as_caller(*a, **k); w, args = h.acl_read_filter()
    return sorted(r[0] for r in con.execute(f"SELECT body FROM docs WHERE {w}", args))
def writable(*a, **k):
    as_caller(*a, **k); w, args = h.acl_write_filter()
    return sorted(r[0] for r in con.execute(f"SELECT body FROM docs WHERE {w}", args))

ALL = ["contrib-read", "maint-write", "owner-only", "team-read", "team-write"]
assert read("pub", "admin", True) == ALL, read("pub", "admin", True)
assert read("v1", "viewer") == [], read("v1", "viewer")
assert read("c1", "contributor") == ["contrib-read"], read("c1", "contributor")
assert read("m1", "maintainer") == ["contrib-read", "maint-write"], read("m1", "maintainer")
assert read("t1", "viewer", True) == ["team-read", "team-write"]
assert writable("m1", "maintainer") == ["maint-write"]
assert writable("a2", "admin") == ["maint-write"]          # admin ⊇ maintainer
assert writable("c1", "contributor") == []
assert writable("t1", None, True) == ["team-write"]
# Role/team without a verified user id grants nothing
assert read(None, "admin", True) == [], read(None, "admin", True)
assert h.caller_principals() == []
# Unknown role ignored; bad role on create rejected
assert read("x", "superuser") == []
as_caller("pub")
try: h.acl_for_caller(min_read_role="owner"); raise SystemExit("expected ValueError")
except ValueError: pass

# Segment ACL: standup membership
con.executescript("""
CREATE TABLE parts(standup_id INT, external_user_id TEXT, active INT);
CREATE TABLE topics(id INTEGER PRIMARY KEY, standup_id INT, title TEXT);
INSERT INTO parts VALUES(1,'amir',1),(1,'eli',1),(2,'eli',1),(2,'amir',0);
INSERT INTO topics(standup_id,title) VALUES(1,'s1-a'),(1,'s1-b'),(2,'s2-a');
""")
def seg(*a, admin_all=False, **k):
    as_caller(*a, **k)
    w, args = h.acl_segment_filter("standup_id", "parts", "standup_id", "external_user_id",
                                   active_column="active", admin_sees_all=admin_all)
    return sorted(r[0] for r in con.execute(f"SELECT title FROM topics WHERE {w}", args))
assert seg("amir") == ["s1-a", "s1-b"], seg("amir")      # left standup 2 (inactive)
assert seg("eli") == ["s1-a", "s1-b", "s2-a"]
assert seg("eve") == []
assert seg(None) == []
assert seg("amir", "admin", admin_all=True) == ["s1-a", "s1-b", "s2-a"]
assert seg("amir", "admin") == ["s1-a", "s1-b"]           # admin bypass is opt-in
w, _ = (as_caller("amir"), h.acl_segment_filter("standup_id", "parts", "standup_id", alias="t"))[1]
assert w.startswith("t.standup_id IN")
try: h.acl_segment_filter("x; DROP TABLE t", "parts", "standup_id"); raise SystemExit("expected ValueError")
except ValueError: pass
print("principals acl ok")
