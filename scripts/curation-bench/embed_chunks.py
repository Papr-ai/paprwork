#!/usr/bin/env python3
"""Curation Bench, step 2 of 3: embed the desktop chunks and the queries with papr-embed-code-1-0.6b.

    python embed_chunks.py DATA_DIR OUT_DIR --onnx model_quantized.onnx --tokenizer tokenizer.json [--trunk t.pt --base Qwen/Qwen3-Embedding-0.6B]

Same recipe as Paprwork's OnnxEmbedder (embedder.ts): no special tokens, <|endoftext|> appended, last-token pool, L2 norm.
Documents are the chunk text as the indexer builds it; queries get the instruction prefix. ONNX int8 is what the desktop
runs; --trunk runs a PyTorch checkpoint (e.g. a v1.1 candidate) through the same tokenisation.
Writes OUT_DIR/chunks.npy (float16, row order = chunks.jsonl.gz), OUT_DIR/chunks.json (keys), OUT_DIR/queries.npy +
queries.json (iid order), OUT_DIR/meta.json (model, backend, sha256 of the weights).
"""
import argparse, gzip, hashlib, json, os, time
import numpy as np

INSTR = "Given a code search query about a repository, retrieve the source code file that must be read or edited"
MAX_DOC, MAX_QUERY = 8192, 512

ap = argparse.ArgumentParser()
ap.add_argument("data"); ap.add_argument("out")
ap.add_argument("--onnx"); ap.add_argument("--trunk"); ap.add_argument("--base", default="Qwen/Qwen3-Embedding-0.6B")
ap.add_argument("--tokenizer", required=True); ap.add_argument("--tok-budget", type=int, default=32768)
# ONNX int8 materialises attention (batch x heads x L x L): cap batch * L^2 so 8k-token chunks run one at a time
ap.add_argument("--attn-budget", type=int, default=8192 * 8192)
ap.add_argument("--query-field", default="queries", help="queries.json field: writer queries (default)")
ap.add_argument("--on-shard", help="shell command run after each saved shard (the GPU script uploads progress)")
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
log = lambda *m: print(f"[{time.strftime('%H:%M:%S')}]", *m, flush=True)

from tokenizers import Tokenizer
tok = Tokenizer.from_file(a.tokenizer)
EOS = tok.token_to_id("<|endoftext|>")
assert EOS is not None


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 24), b""):
            h.update(b)
    return h.hexdigest()


if a.onnx:
    import onnxruntime as ort
    if hasattr(ort, "preload_dlls"):
        ort.preload_dlls()
    so = ort.SessionOptions(); so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess = ort.InferenceSession(a.onnx, so, providers=[p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in ort.get_available_providers()])
    backend, weights = "onnx-int8:" + ",".join(sess.get_providers()), a.onnx

    def run(seqs):  # right padding, pool the last real token (the export hard-codes positions 0..L-1)
        L = max(map(len, seqs)); lens = np.array([len(s) for s in seqs])
        ids = np.zeros((len(seqs), L), np.int64); mask = np.zeros((len(seqs), L), np.int64)
        for i, s in enumerate(seqs):
            ids[i, :len(s)] = s; mask[i, :len(s)] = 1
        h = sess.run(["last_hidden_state"], {"input_ids": ids, "attention_mask": mask})[0][np.arange(len(seqs)), lens - 1].astype(np.float32)
        return h / np.linalg.norm(h, axis=1, keepdims=True)
else:
    import torch
    from transformers import AutoModel
    m = AutoModel.from_pretrained(a.base, dtype=torch.float32, attn_implementation="sdpa")
    sd = torch.load(a.trunk, map_location="cpu", weights_only=False)
    for k in ("model_state_dict", "state_dict", "trunk"):
        if isinstance(sd, dict) and k in sd:
            sd = sd[k]
    sd = {k.split("model.", 1)[1] if k.startswith(("model.", "encoder.model.")) else k: v for k, v in sd.items()}
    assert not m.load_state_dict(sd, strict=False).missing_keys
    m = m.cuda().eval(); backend, weights = "torch-fp32", a.trunk

    @torch.no_grad()
    def run(seqs):  # left padding, last position
        L = max(map(len, seqs))
        ids = torch.zeros((len(seqs), L), dtype=torch.long); mask = torch.zeros_like(ids)
        for i, s in enumerate(seqs):
            ids[i, L - len(s):] = torch.tensor(s); mask[i, L - len(s):] = 1
        h = m(input_ids=ids.cuda(), attention_mask=mask.cuda()).last_hidden_state[:, -1].float()
        return torch.nn.functional.normalize(h, dim=-1).cpu().numpy()


def ids(text, mx):
    return tok.encode(text, add_special_tokens=False).ids[: mx - 1] + [EOS]


def embed(seqs, name=None, shard=4000):
    """Length-sorted, token-budget batches. Returns rows in input order. With name, finished shards of `shard` rows (in
    sorted order) are saved under OUT_DIR/parts/ and reused, so a preempted spot VM resumes where it stopped."""
    out = np.zeros((len(seqs), 1024), np.float16); order = sorted(range(len(seqs)), key=lambda i: len(seqs[i])); t0 = time.time()
    parts = os.path.join(a.out, "parts"); os.makedirs(parts, exist_ok=True)
    for s0 in range(0, len(order), shard):
        idx = order[s0:s0 + shard]; f = os.path.join(parts, f"{name}_{s0:07d}.npy") if name else None
        if f and os.path.exists(f):
            out[idx] = np.load(f); continue
        i = 0
        while i < len(idx):
            j = i
            while j < len(idx) and (j - i + 1) * len(seqs[idx[j]]) <= a.tok_budget and (j - i + 1) * len(seqs[idx[j]]) ** 2 <= a.attn_budget:
                j += 1
            j = max(j, i + 1)
            out[idx[i:j]] = run([seqs[k] for k in idx[i:j]])
            i = j
        if f:
            np.save(f + ".tmp.npy", out[idx]); os.replace(f + ".tmp.npy", f)
            if a.on_shard:
                os.system(a.on_shard)
        log(f"{min(s0 + shard, len(order))}/{len(seqs)} ({time.time() - t0:.0f}s)")
    return out


keys, docs = [], []
with gzip.open(os.path.join(a.data, "chunks.jsonl.gz"), "rt") as f:
    for line in f:
        c = json.loads(line); keys.append([c["blob"], c["chunk"], c["line_start"], c["line_end"]]); docs.append(ids(c["text"], MAX_DOC))
log(f"{len(docs)} chunks, {sum(map(len, docs)):,} tokens; backend {backend}")
np.save(os.path.join(a.out, "chunks.npy"), embed(docs, "chunks")); json.dump(keys, open(os.path.join(a.out, "chunks.json"), "w"))
Q = json.load(open(os.path.join(a.data, "queries.json")))
qids = sorted(Q)
qv = embed([ids(f"Instruct: {INSTR}\nQuery:{Q[i][a.query_field][0]}", MAX_QUERY) for i in qids])
np.save(os.path.join(a.out, "queries.npy"), qv); json.dump(qids, open(os.path.join(a.out, "queries.json"), "w"))
# What bash.ts sends today: deviceHitsForGrep(path, grepInfo.pattern), the raw grep pattern.
import re
GREP = re.compile(r"""\bgrep\s+(?:-[a-zA-Z]+\s+)*(?:"([^"]+)"|'([^']+)'|([^"'\s]+))\s+(.+)""", re.I)
S = json.load(open(os.path.join(a.data, "set.json")))
cmd = {r["iid"]: r["cmd"] for g in S for r in S[g]}
def pat(i):
    m = GREP.search(cmd[i])
    return next((x for x in m.groups()[:3] if x), cmd[i][:200]) if m else cmd[i][:200]
pv = embed([ids(f"Instruct: {INSTR}\nQuery:{pat(i)}", MAX_QUERY) for i in qids])
np.save(os.path.join(a.out, "queries_pattern.npy"), pv); json.dump(qids, open(os.path.join(a.out, "queries_pattern.json"), "w"))
json.dump({"model": "papr-embed-code-1-0.6b", "backend": backend, "weights_sha256": sha256(weights), "chunks": len(docs)}, open(os.path.join(a.out, "meta.json"), "w"))
log("DONE")
