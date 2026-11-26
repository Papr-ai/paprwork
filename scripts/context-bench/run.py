"""Context Bench runner: every retrieval method x K in {3,5,10}; scores Hit@K, p95 latency, tokens, Retrieval Loss.

Retrieval-Loss = -log10(Hit@K) + 0.5 * p95_ms/100 + 0.01 * tokens/1000   (Papr's three-term metric)

Hit = the context a method returns at K contains the gold answer (>= `need` gold strings). For chat_full questions the
gold is a whole earlier message: hit only if that message comes back complete. Tokens = chars/4 of what the agent
would actually read. Latency = retrieval only (query embed + search + rerank), not the LLM answering.
usage: run.py [lex] [dense] [jev] [memory] [structured] [all]
"""
import json, os, re, sys, time, math, sqlite3
import numpy as np, requests
from rank_bm25 import BM25Okapi
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("CTX_BENCH_DATA", f"{HERE}/data")
U = [json.loads(l) for l in open(f"{DATA}/corpus.jsonl")]
Q = json.load(open(f"{DATA}/questions.json"))
QI = {q["id"]: i for i, q in enumerate(Q)}
MEM = os.environ.get("PAPR_MEMORY_URL", "https://memory.papr.ai")
H = {"X-API-Key": os.environ.get("PAPR_API_KEY", ""), "Content-Type": "application/json"}
INV_DB = os.environ.get("CTX_BENCH_INVESTOR_DB", f"{DATA}/investors.db")
THIS_CHAT = os.environ.get("CTX_BENCH_TARGET_CHAT", "9fdc1282")

parents = {}
for u in U:
    parents.setdefault(u["parent"], []).append(u)


def full(p):
    ws = parents[p]
    t = ws[0]["text"]
    for w in ws[1:]:
        t += w["text"][200:]
    return t


tok = lambda s: re.findall(r"[a-z0-9$%#.@_-]+", s.lower())
ntok = lambda s: max(1, len(s) // 4)

_bm25 = BM25Okapi([tok(u["text"]) for u in U])


def r_bm25(q):
    t = time.time()
    s = _bm25.get_scores(tok(q["query"]))
    return list(np.argsort(-s)[:50]), (time.time() - t) * 1000


def r_grep(q):
    """What `grep -rn <kw>` hands the agent: every line-match in corpus order (no ranking)."""
    t = time.time()
    kw = q["kw"].lower()
    return [i for i, u in enumerate(U) if kw in u["text"].lower()][:50], (time.time() - t) * 1000


VEC = {}


def load(tag):
    if tag not in VEC:
        z = np.load(f"{DATA}/vec_{tag}.npz")
        D = z["D"] / np.linalg.norm(z["D"], axis=1, keepdims=True)
        Qv = z["Q"] / np.linalg.norm(z["Q"], axis=1, keepdims=True)
        VEC[tag] = (D, Qv, z["qlat"])
    return VEC[tag]


def r_dense(tag, local_ms=None):
    """local_ms: replace the cloud query-embed latency with the measured on-device one (ANE ~20 ms)."""
    def f(q):
        D, Qv, lat = load(tag)
        i = QI[q["id"]]
        t = time.time()
        ids = list(np.argsort(-(D @ Qv[i]))[:50])
        return ids, (local_ms if local_ms is not None else float(lat[i])) + (time.time() - t) * 1000
    return f


def rrf(*lists, k=60):
    sc = {}
    for L in lists:
        for r, i in enumerate(L):
            sc[i] = sc.get(i, 0) + 1 / (k + r)
    return sorted(sc, key=lambda i: -sc[i])


def r_fuse(*fns):
    def f(q):
        outs = [fn(q) for fn in fns]
        return rrf(*[o[0] for o in outs])[:50], max(o[1] for o in outs)  # run in parallel -> slowest arm
    return f


def jev(q, cand):
    st = {"question": q["query"][:600],
          "candidates": {f"c{j}": U[i]["text"][:900] for j, i in enumerate(cand)}}
    qs = {f"c{j}": {"type": "noul", "instructions":
                    f"Does candidate c{j} contain the information that answers the question?"} for j in range(len(cand))}
    t = time.time()
    try:
        r = requests.post(MEM + "/v1/typesafe/systemone", headers=H,
                          json={"model": "jev-latest", "state": st, "questions": qs}, timeout=30)
        a = r.json()["answers"]
        p = np.array([a[f"c{j}"]["noul"] for j in range(len(cand))])
        return [cand[j] for j in np.argsort(-p)], (time.time() - t) * 1000, True
    except Exception:
        return cand, (time.time() - t) * 1000, False


JEV_FAIL = [0]


def r_jev(base, n=20):
    def f(q):
        c, l = base(q)
        out, lj, ok = jev(q, c[:n])
        JEV_FAIL[0] += not ok
        return out + c[n:], l + lj
    return f


def r_memory(q, k=20):
    """Production Papr memory search as an agent calls it today (no chat scope: agents search across chats)."""
    t = time.time()
    try:
        r = requests.post(MEM + "/v1/memory/search", headers=H, params={"max_memories": k, "max_nodes": 10},
                          json={"query": q["query"], "rank_results": False,
                                # Tagged so training exports skip bench traffic (QueryLog.useCase).
                                "metadata": {"useCase": "eval_bench"}}, timeout=90)
        mems = (r.json().get("data") or {}).get("memories") or []
    except Exception:
        mems = []
    return [m.get("content", "") or "" for m in mems], (time.time() - t) * 1000


def r_structured(q):
    t = time.time()
    out = []
    if q.get("sql"):
        c = sqlite3.connect(f"file:{INV_DB}?mode=ro", uri=True)
        out.append(json.dumps(c.execute(q["sql"]).fetchall()))
    if q.get("graphql"):
        try:
            r = requests.post(MEM + "/v1/graphql", headers=H, json={"query": q["graphql"]}, timeout=30)
            out.append(r.text)
        except Exception as e:
            out.append(str(e))
    return out, (time.time() - t) * 1000


def ctx_units(ids, K, expand):
    """Top-K -> text blocks. chunk | message (whole parent) | neighbors (parent + previous message + next message)."""
    seen, blocks = set(), []
    for i in ids:
        u = U[i]
        key = u["id"] if expand == "chunk" else u["parent"]
        if key in seen:
            continue
        seen.add(key)
        if expand == "chunk":
            blocks.append((u, u["text"]))
        elif expand == "message" or u["kind"] != "chat":
            blocks.append((u, full(u["parent"])))
        else:
            nb = [f"c:{u['chat']}:{u['msg'] + d}" for d in (-1, 0, 1)]
            blocks.append((u, "\n---\n".join(full(p) if p == u["parent"] else full(p)[:3000] for p in nb if p in parents)))
        if len(blocks) == K:
            break
    return blocks


def judge(q, blocks):
    if q["kind"] == "full":
        tgt = f"c:{THIS_CHAT}:{q['gold_msg']}"
        if tgt not in parents:
            return False
        want = len(full(tgt)) * 0.95
        return any(u is not None and u.get("parent") == tgt and len(t) >= want for u, t in blocks)
    text = "\n".join(t for _, t in blocks).lower()
    return sum(g.lower() in text for g in q["gold"]) >= q["need"]


def evaluate(name, fn, kind="units", Ks=(3, 5, 10), expands=("chunk",), only=None, workers=4):
    qs = [q for q in Q if (only is None and q["source"] != "graph_or_db") or (only is not None and q["source"] in only)]
    with ThreadPoolExecutor(workers) as ex:
        res = list(ex.map(fn, qs))
    rows = []
    for expand in expands:
        for K in Ks:
            hits, lat, toks, per, miss = 0, [], [], {}, []
            for q, (ids, ms) in zip(qs, res):
                blocks = ctx_units(ids, K, expand) if kind == "units" else [(None, t) for t in ids[:K]]
                h = judge(q, blocks)
                hits += h
                lat.append(ms)
                toks.append(sum(ntok(t) for _, t in blocks))
                per.setdefault(q["cat"], []).append(h)
                if not h:
                    miss.append(q["id"])
            hk = max(hits / len(qs), 1e-3)
            p95 = float(np.percentile(lat, 95))
            tk = float(np.mean(toks))
            loss = -math.log10(hk) + 0.5 * p95 / 100 + 0.01 * tk / 1000
            rows.append(dict(method=name, expand=expand, K=K, n=len(qs), hits=hits, hit=round(hits / len(qs), 3),
                             p95_ms=round(p95), tokens=round(tk), loss=round(loss, 3),
                             by_cat={c: f"{sum(v)}/{len(v)}" for c, v in sorted(per.items())}, misses=miss))
            r = rows[-1]
            print(f"{name:42s} {expand:9s} K={K:<2d} hit {hits:3d}/{len(qs)}  p95 {r['p95_ms']:6d} ms  "
                  f"tok {r['tokens']:6d}  loss {r['loss']:.3f}  {r['by_cat']}", flush=True)
    return rows



if __name__ == "__main__":
    which = sys.argv[1:] or ["all"]
    on = lambda w: w in which or "all" in which
    out = []
    tags = sorted(t[4:-4] for t in os.listdir(DATA) if t.startswith("vec_") and t.endswith(".npz"))
    EX = ("chunk", "message", "neighbors")
    if on("lex"):
        out += evaluate("grep (agent keyword)", r_grep, expands=EX)
        out += evaluate("bm25", r_bm25, expands=EX)
    for tag in tags:
        local = None  # qlat in the npz is already the measured query latency (ANE: ~18 ms)
        if on("dense"):
            out += evaluate(f"dense {tag}", r_dense(tag, local), expands=EX)
            out += evaluate(f"bm25+dense {tag}", r_fuse(r_bm25, r_dense(tag, local)), expands=EX)
            out += evaluate(f"grep+dense {tag}", r_fuse(r_grep, r_dense(tag, local)), expands=EX)
        if on("jev"):
            out += evaluate(f"bm25+dense+jev {tag}", r_jev(r_fuse(r_bm25, r_dense(tag, local))), expands=("chunk", "message"))
    if on("memory") and os.environ.get("CTX_BENCH_SKIP_MEMORY") != "1":
        out += evaluate("papr memory search (prod)", r_memory, kind="texts", workers=3)
    if on("structured"):
        out += evaluate("sql/graphql (schema tool)", r_structured, kind="texts", Ks=(10,), only={"graph_or_db"})
        if os.environ.get("CTX_BENCH_SKIP_MEMORY") != "1":
            out += evaluate("papr memory search on graph Qs", r_memory, kind="texts", only={"graph_or_db"}, workers=3)
        out += evaluate("bm25 on graph Qs", r_bm25, only={"graph_or_db"}, expands=("message",))
    if JEV_FAIL[0]:
        print("jev failures:", JEV_FAIL[0])
    fn = f"{DATA}/results_{'_'.join(which)}.json"
    json.dump(out, open(fn, "w"), indent=1)
    print("wrote", fn)
