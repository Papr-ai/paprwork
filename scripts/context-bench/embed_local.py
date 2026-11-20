"""On-device papr-embed-code-1-0.6b via the shipped CoreML helper (Neural Engine) -> data/vec_ane-0.6b.npz.
Same tokenization as CoreMLEmbedder (no special tokens, truncate, append <|endoftext|>); same query prefix shape.
INSTR is a chat/doc instruction rather than the code-search one (it's free text; the code one says 'source code file')."""
import json, os, subprocess, time, sys, numpy as np
from tokenizers import Tokenizer
HERE = os.path.dirname(os.path.abspath(__file__))
MD = os.path.expanduser(os.environ["PAPR_EMBED_MODEL_DIR"])  # <PAPR_HOME>/data/models/papr-embed-code-1-0.6b
HELPER = os.path.expanduser("~/Developer/paprwork/native/papr-embed-coreml/build/papr-embed-coreml")
INSTR = os.environ.get("CTX_INSTR", "Given a question about past work, retrieve the conversation message or document passage that answers it")
EOS = 151643
tok = Tokenizer.from_file(f"{MD}/tokenizer.json")
p = subprocess.Popen([HELPER, f"{MD}/coreml/papr-embed-code-1-0.6b.mlpackage"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
ready = json.loads(p.stdout.readline())
assert ready.get("ready"), ready
MAX = max(int(f.replace("len_", "")) for f in ready["functions"])
print("helper ready, max tokens", MAX, flush=True)
n = 0
def run(text, bg):
    global n
    n += 1
    ids = tok.encode(text, add_special_tokens=False).ids[: MAX - 1] + [EOS]
    p.stdin.write(json.dumps({"id": n, "ids": ids, **({"bg": True} if bg else {})}) + "\n")
    m = json.loads(p.stdout.readline())
    v = np.array(m["embedding"], dtype=np.float32)
    return v / np.linalg.norm(v)
units = [json.loads(l) for l in open(f"{HERE}/data/corpus.jsonl")]
qs = json.load(open(f"{HERE}/data/questions.json"))
part = f"{HERE}/data/ane_part.npy"
D = list(np.load(part)) if os.path.exists(part) else []
t0 = time.time()
for i in range(len(D), len(units)):
    D.append(run(units[i]["text"], True).astype(np.float16))
    if i % 250 == 0:
        np.save(part, np.array(D)); print(i, "/", len(units), f"{time.time()-t0:.0f}s", flush=True)
lat, Qv = [], []
for q in qs:
    t = time.time(); Qv.append(run(f"Instruct: {INSTR}\nQuery:{q['query']}", False)); lat.append((time.time() - t) * 1000)
np.savez(f"{HERE}/data/vec_ane-0.6b.npz", D=np.array(D, dtype=np.float32), Q=np.array(Qv), qlat=np.array(lat))
print("DONE", len(D), f"query p50 {np.median(lat):.0f} ms p95 {np.percentile(lat,95):.0f} ms", flush=True)
p.stdin.close()
