"""Seed a bench-only Papr workspace with a Context Bench dataset, through the same production paths users go through.

  chats    -> POST /v1/messages (process_messages=true, one session per chat, in message order): the path Papr Work
              syncs chat turns with, so the memory arm measures what the app actually builds.
  docs     -> POST /v1/memory/batch (50 per call, sections over 15 KB split).
  graph    -> POST /v1/memory with memory_policy mode=manual: the exact Company nodes the GraphQL questions read, so
              those questions don't flicker with LLM extraction.

Safe to re-run: every item seeded is recorded in a local ledger and skipped next time. Writes a manifest next to the
ledger (and to GCS with --manifest-gs). Run it with a WRITE key on the bench namespace that never leaves this machine;
CI only gets a read-only key. Never point it at a real workspace.

usage: PAPR_BENCH_WRITE_KEY=... CTX_BENCH_DATA=ctx/data python seed.py [--only chats,docs,graph]
       [--limit-chats N] [--limit-docs N] [--workers 4] [--dry-run] [--manifest-gs gs://.../manifest.json]
"""
import json, os, sys, time, threading, subprocess, collections, datetime
import requests
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("CTX_BENCH_DATA", f"{HERE}/data")
MEM = os.environ.get("PAPR_MEMORY_URL", "https://memory.papr.ai")
KEY = os.environ.get("PAPR_BENCH_WRITE_KEY", "")
VERSION = os.environ.get("CTX_BENCH_VERSION", "v1")
TAG = f"context-bench-{VERSION}"
# Everything is written as a dedicated bench end user, never the key owner's own account, so memory's
# cross-session processing can't mix bench chats with a real person's chats.
BENCH_USER = os.environ.get("CTX_BENCH_EXTERNAL_USER", f"papr-context-bench-{VERSION}")
MAX_MSG, MAX_MEM = 80_000, 14_000  # app's sync payload cap; memory's 15,000-byte item cap with headroom

args = sys.argv[1:]
opt = lambda f, d=None: args[args.index(f) + 1] if f in args else d
ONLY = set((opt("--only") or "chats,docs,graph").split(","))
DRY = "--dry-run" in args
H = {"X-API-Key": KEY, "Content-Type": "application/json"}
LEDGER = os.path.expanduser(opt("--ledger") or f"~/.config/papr-bench/ledger-{TAG}.json")
lock = threading.Lock()
ledger = json.load(open(LEDGER)) if os.path.exists(LEDGER) else {"chats": {}, "docs": {}, "graph": {}, "errors": []}


def save():
    with lock:
        os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
        json.dump(ledger, open(LEDGER + ".tmp", "w"), indent=0)
        os.replace(LEDGER + ".tmp", LEDGER)


def post(path, body, tries=4):
    for i in range(tries):
        try:
            r = requests.post(MEM + path, headers=H, json=body, timeout=120)
            if r.status_code < 300:
                return r.json()
            if r.status_code < 500 and r.status_code != 429:
                raise RuntimeError(f"{path} {r.status_code}: {r.text[:300]}")
        except requests.RequestException as e:
            if i == tries - 1:
                raise RuntimeError(f"{path}: {e}")
        time.sleep(2 ** i * 2)
    raise RuntimeError(f"{path}: gave up after {tries} tries")


def clip(s, n):
    b = s.encode()
    return s if len(b) <= n else b[:n].decode(errors="ignore")


def load():
    units = [json.loads(l) for l in open(f"{DATA}/corpus.jsonl")]
    parents = collections.OrderedDict()
    for u in units:
        parents.setdefault(u["parent"], []).append(u)
    full = lambda ws: ws[0]["text"] + "".join(w["text"][200:] for w in ws[1:])
    chats, docs = collections.OrderedDict(), []
    for p, ws in parents.items():
        u = ws[0]
        if u["kind"] == "chat":
            chats.setdefault(u["chat"], []).append(dict(id=p, msg=u["msg"], role=u["role"], ts=u.get("ts"), title=u.get("title"), text=full(ws)))
        else:
            docs.append(dict(id=p, doc=u["doc"], text=full(ws)))
    for c in chats.values():
        c.sort(key=lambda m: m["msg"])
    graph = json.load(open(f"{DATA}/graph_seed.json")) if os.path.exists(f"{DATA}/graph_seed.json") else []
    return units, chats, docs, graph


def server_count(session):
    r = requests.get(f"{MEM}/v1/messages/sessions/{session}", headers=H,
                     params={"limit": 1, "external_user_id": BENCH_USER}, timeout=60)
    return (r.json().get("total_count") or 0) if r.status_code == 200 else 0


def seed_chat(chat, msgs):
    session = f"bench-{VERSION}-{chat}"
    # Messages go in one at a time, in order, so the server's count says exactly which ones landed. This keeps a run
    # that was killed mid-chat from posting the same messages twice.
    if not DRY:
        n = server_count(session)
        with lock:
            for m in msgs[:n]:
                ledger["chats"].setdefault(m["id"], "on-server")
    for m in msgs:
        if m["id"] in ledger["chats"]:
            continue
        body = {"content": clip(m["text"], MAX_MSG), "role": m["role"], "sessionId": session, "process_messages": True,
                "external_user_id": BENCH_USER,
                "metadata": {"conversationId": session, "createdAt": m["ts"], "role": m["role"],
                             "customMetadata": {"bench": TAG, "bench_id": m["id"], "bench_chat": chat}}}
        if m["msg"] == 0 and m.get("title"):
            body["title"] = m["title"]
        if DRY:
            continue
        r = post("/v1/messages", body)
        with lock:
            ledger["chats"][m["id"]] = r.get("objectId")
        save()
    # Analysis runs every 15 messages; flush the tail so the last messages of each chat become memories too.
    if not DRY and session not in ledger.setdefault("flushed", {}):
        r = post(f"/v1/messages/sessions/{session}/process?external_user_id={BENCH_USER}", {})
        with lock:
            ledger["flushed"][session] = r.get("message") or r.get("status") or True
    save()
    return chat, len(msgs)


def doc_items(docs):
    for d in docs:
        t, part = d["text"], 0
        while t:
            piece, t = clip(t, MAX_MEM), t[len(clip(t, MAX_MEM)):]
            yield f"{d['id']}#{part}", {"content": piece, "type": "text", "metadata": {
                "sourceType": "document", "customMetadata": {"bench": TAG, "bench_id": d["id"], "bench_doc": d["doc"], "part": part}}}
            part += 1


def seed_docs(docs):
    todo = [(i, m) for i, m in doc_items(docs) if i not in ledger["docs"]]
    for k in range(0, len(todo), 50):
        chunk = todo[k:k + 50]
        if DRY:
            continue
        r = post("/v1/memory/batch", {"external_user_id": BENCH_USER, "memories": [m for _, m in chunk]})
        # The batch reply does not echo every item back; failures are listed by index, everything else was accepted.
        bad = {e.get("index") for e in (r.get("errors") or []) if isinstance(e, dict)}
        if bad or r.get("total_failed"):
            ledger["errors"].append({"docs_batch": k, "errors": r.get("errors")})
        for j, (i, _) in enumerate(chunk):
            if j not in bad:
                ledger["docs"][i] = r.get("batch_id") or True
        save()
        print(f"docs {min(k + 50, len(todo))}/{len(todo)}", flush=True)
    return len(todo)


def seed_graph(graph):
    n = 0
    for e in graph:
        if e["name"] in ledger["graph"] or DRY:
            continue
        nid = "bench_" + "".join(c if c.isalnum() else "_" for c in e["name"].lower())
        r = post("/v1/memory", {"content": f"{e['name']}: {e['description']}", "type": "text", "external_user_id": BENCH_USER,
                                "metadata": {"customMetadata": {"bench": TAG, "bench_entity": e["name"]}},
                                "memory_policy": {"mode": "manual", "nodes": [
                                    {"id": nid, "type": e["type"], "properties": {"name": e["name"], "description": e["description"]}}]}})
        ledger["graph"][e["name"]] = (r.get("data") or [{}])[0].get("memoryId") if isinstance(r.get("data"), list) else True
        n += 1
    save()
    return n


if __name__ == "__main__":
    if not KEY:
        sys.exit("PAPR_BENCH_WRITE_KEY not set (a write key on the bench-only namespace; never a real workspace)")
    # One seeder at a time: two runs posting the same chat would duplicate messages.
    import fcntl
    _lockf = open(LEDGER + ".lock", "w")
    try:
        fcntl.flock(_lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit("another seed.py run holds " + LEDGER + ".lock")
    units, chats, docs, graph = load()
    lc, ld = opt("--limit-chats"), opt("--limit-docs")
    if lc:
        chats = collections.OrderedDict(sorted(chats.items(), key=lambda kv: len(kv[1]))[:int(lc)])
    if ld:
        docs = docs[:int(ld)]
    print(f"{TAG}: {sum(map(len, chats.values()))} messages in {len(chats)} chats, {len(docs)} doc sections, {len(graph)} entities"
          f"{' (dry run)' if DRY else ''}", flush=True)
    t0 = time.time()
    if "graph" in ONLY:
        print("graph entities seeded:", seed_graph(graph), flush=True)
    if "docs" in ONLY:
        seed_docs(docs)
    if "chats" in ONLY:
        with ThreadPoolExecutor(int(opt("--workers") or 4)) as ex:
            for chat, n in ex.map(lambda kv: seed_chat(*kv), chats.items()):
                print(f"chat {chat}: {n} messages", flush=True)
    manifest = {"dataset": TAG, "memory_url": MEM, "seeded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "messages": len(ledger["chats"]), "doc_items": len(ledger["docs"]), "entities": len(ledger["graph"]),
                "errors": len(ledger["errors"]), "seconds": round(time.time() - t0)}
    print(json.dumps(manifest), flush=True)
    if not DRY:
        json.dump(manifest, open(LEDGER.replace(".json", ".manifest.json"), "w"), indent=1)
        if opt("--manifest-gs"):
            subprocess.run(["gcloud", "storage", "cp", "-q", LEDGER.replace(".json", ".manifest.json"), opt("--manifest-gs")], check=True)
