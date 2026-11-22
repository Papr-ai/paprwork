"""Embed corpus units + queries with a Papr cloud embedding model -> data/vec_<tag>.npz (resumable).
usage: embed.py <model> [band_schema_id|-]"""
import json, os, sys, time, requests, numpy as np
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = sys.argv[1]; SCHEMA = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "-" else None
URL = os.environ.get("PAPR_MEMORY_URL", "https://memory.papr.ai") + "/v1/embeddings"
H = {"X-API-Key": os.environ["PAPR_API_KEY"], "Content-Type": "application/json"}
INSTR = "Given a question about past work, retrieve the conversation message or document passage that answers it"
def emb(texts, kind):
    body = {"model": MODEL, "input": texts, "input_type": kind}
    if kind == "query": body["instruction"] = INSTR
    if SCHEMA: body["band_schema_id"] = SCHEMA
    for a in range(7):
        try:
            r = requests.post(URL, headers=H, json=body, timeout=180)
            if r.ok: return [d["embedding"] for d in r.json()["data"]]
            print("HTTP", r.status_code, r.text[:160], flush=True)
        except Exception as e: print("err", e, flush=True)
        time.sleep(min(60, 2 ** a))
    raise SystemExit("embedding failed")
units = [json.loads(l) for l in open(f"{HERE}/data/corpus.jsonl")]
qs = json.load(open(f"{HERE}/data/questions.json"))
tag = (MODEL + ("+" + SCHEMA if SCHEMA else "")).replace(":", "_")
out = f"{HERE}/data/vec_{tag}.npz"
part = f"{HERE}/data/vec_{tag}.part"
os.makedirs(part, exist_ok=True)
B = 16
todo = [i for i in range(0, len(units), B) if not os.path.exists(f"{part}/{i}.npy")]
t0 = time.time()
def run(i):
    v = np.array(emb([u["text"][:6000] for u in units[i:i + B]], "document"), dtype=np.float16)
    np.save(f"{part}/{i}.npy", v); return i
with ThreadPoolExecutor(int(os.environ.get("EMB_WORKERS", "3"))) as ex:
    for n, _ in enumerate(ex.map(run, todo)):
        if n % 25 == 0: print(tag, (len(units) // B - len(todo) + n) * B, "/", len(units), f"{time.time()-t0:.0f}s", flush=True)
D = np.concatenate([np.load(f"{part}/{i}.npy") for i in range(0, len(units), B)]).astype(np.float32)
lat, Qv = [], []
for q in qs:
    t = time.time(); Qv.append(emb([q["query"]], "query")[0]); lat.append((time.time() - t) * 1000)
np.savez(out, D=D, Q=np.array(Qv, dtype=np.float32), qlat=np.array(lat))
print("DONE", tag, D.shape, f"query p50 {np.median(lat):.0f} ms")
