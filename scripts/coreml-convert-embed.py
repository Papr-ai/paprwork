"""Convert papr-embed-code-1-0.6b to CoreML (fp16) for QUERIES with our recipe: right padding, EOS appended, last-token
pool, L2 norm. Enumerated lengths so the ANE gets static shapes. Then measure on CPU_AND_NE vs CPU_AND_GPU vs ALL:
latency p50/p95 and cosine vs PyTorch fp32. Usage: coreml06.py MODEL_DIR OUT.mlpackage"""
import json, sys, time, statistics as st, numpy as np, torch, coremltools as ct
from transformers import AutoTokenizer, AutoModel
from coremltools.converters.mil.frontend.torch import ops as _ops
_orig_cast = _ops._cast
def _cast_patch(context, node, dtype, dtype_name):  # coremltools 9 + torch 2.9: int() on a 1-element tensor
    x = context[node.inputs[0]]
    if x.val is not None and getattr(x.val, "shape", ()) and x.val.size == 1:
        context.add(_ops.mb.const(val=dtype(x.val.reshape(()).item()), name=node.name)); return
    return _orig_cast(context, node, dtype, dtype_name)
_ops._cast = _cast_patch

SRC, OUT = sys.argv[1], sys.argv[2]
LENS = [64]
INSTR = "Given a code search query about a repository, retrieve the source code file that must be read or edited"
QS = ["where does the data room open the demo viewer", "function that publishes the app to vercel", "sql table for investor intro paths",
      "how are job events subscribed in mini apps", "retry backoff for cloud sync push",
      "which component renders the pitch deck slide carousel and handles keyboard navigation between slides"]

import transformers.models.qwen3.modeling_qwen3 as _q3
def _rms_fwd(self, x):
    # ANE-stable RMSNorm (ANEMLL trick): layer_norm over [x, -x] has zero mean, so its variance is mean(x^2);
    # the ANE's fused layer_norm stays in range where x.pow(2) overflows fp16 at Qwen3's ~6000 activations.
    d = x.shape[-1]
    y = torch.nn.functional.layer_norm(torch.cat([x, -x], -1), (2 * d,), eps=self.variance_epsilon)
    return self.weight * y[..., :d]
_q3.Qwen3RMSNorm.forward = _rms_fwd
out = lambda **k: print(json.dumps(k), flush=True)
tok = AutoTokenizer.from_pretrained(SRC); eos = tok.eos_token_id
base = AutoModel.from_pretrained(SRC, dtype=torch.float32, attn_implementation="eager").eval()


class Q(torch.nn.Module):
    """input_ids [1, L] right-padded, last_index [1] -> unit vector [1, 1024]."""
    def __init__(s, m): super().__init__(); s.m = m
    def forward(s, input_ids):
        # Causal model + right padding: the last real token never attends to the padding, so no mask input is needed
        # (CoreML before macOS 15 allows only one enumerated-shape input).
        h = s.m(input_ids=input_ids).last_hidden_state
        return h  # host picks the last real token and L2-normalises (one gather + norm, ~0.1 ms)


def ids_for(q):
    x = tok(f"Instruct: {INSTR}\nQuery:{q}", add_special_tokens=False)["input_ids"][: LENS[-1] - 1] + [eos]
    L = next(l for l in LENS if l >= len(x))
    ids = np.zeros((1, L), np.int32); m = np.zeros((1, L), np.int32); ids[0, :len(x)] = x; m[0, :len(x)] = 1
    return ids, m, np.array([len(x) - 1], np.int32)


def ref(q):
    ids, m, li = ids_for(q); n = int(li[0]) + 1
    with torch.no_grad():
        h = base(input_ids=torch.tensor(ids[:, :n], dtype=torch.long)).last_hidden_state[:, -1]
    return torch.nn.functional.normalize(h, dim=-1)[0].numpy()


R = {q: ref(q) for q in QS}; out(what="refs_done")
if "--skip-convert" not in sys.argv:
    t0 = time.time(); w = Q(base).eval()
    ex = ids_for(QS[0])
    tr = torch.jit.trace(w, (torch.tensor(ex[0], dtype=torch.long),))
    shape = (1, 64)
    ml = ct.convert(tr, inputs=[ct.TensorType("input_ids", shape=shape, dtype=np.int32),
                    ],
                    outputs=[ct.TensorType("hidden")], compute_precision=ct.precision.FLOAT16,
                    minimum_deployment_target=ct.target.macOS14, convert_to="mlprogram", skip_model_load=True)
    out(what="converted", s=round(time.time() - t0)); ml.save(OUT); out(what="saved", s=round(time.time() - t0))
    del ml, tr, w
import gc; del base; gc.collect()
CUS = [a.split("=",1)[1] for a in sys.argv if a.startswith("--cu=")] or ["CPU_AND_NE", "CPU_AND_GPU", "ALL"]
for cu in CUS:
    t0 = time.time(); m = ct.models.MLModel(OUT, compute_units=getattr(ct.ComputeUnit, cu)); load = time.time() - t0
    def emb(q):
        a = ids_for(q); h = m.predict({"input_ids": a[0]})["hidden"][0, int(a[2][0])].astype(np.float32)
        return h / np.linalg.norm(h)
    t0 = time.time(); emb(QS[0]); first = time.time() - t0
    lat, cos = [], []
    for _ in range(5):
        for q in QS:
            t0 = time.time(); v = emb(q); lat.append(time.time() - t0); cos.append(float(v @ R[q]))
    lat.sort()
    out(what="coreml", compute=cu, load_s=round(load, 1), first_ms=round(first * 1000), p50_ms=round(st.median(lat) * 1000, 1),
        p95_ms=round(lat[int(.95 * (len(lat) - 1))] * 1000, 1), cos_min=round(min(cos), 5), cos_mean=round(float(np.mean(cos)), 5))
