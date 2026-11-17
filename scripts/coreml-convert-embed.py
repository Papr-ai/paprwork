"""Build the release CoreML model for papr-embed-code-1-0.6b: one multifunction .mlpackage, one function per fixed length.
Each function: input_ids [1, L] int32 (right-padded, EOS 151643 appended) + last_index [1] int32 -> embedding [1, 1024], unit norm.
ANE-safe: fixed shapes, RMSNorm as layer_norm([x, -x]), normalisation pre-scaled by max|h| so fp16 never overflows.

  convert : coreml_release.py convert MODEL_DIR OUT_DIR [--w8]
  bench   : coreml_release.py bench   MODEL_DIR OUT_DIR/papr-embed-code-1-0.6b.mlpackage CU
"""
import json, os, sys, time, statistics as st, numpy as np, torch
out = lambda **k: print(json.dumps(k), flush=True)
LENS = [int(x) for x in os.environ.get("LENS", "64,256,1024,4096").split(",")]
EOS = 151643  # <|endoftext|>: the model card recipe. tokenizer.eos_token is <|im_end|> (151645), which is WRONG here
INSTR = "Given a code search query about a repository, retrieve the source code file that must be read or edited"
mode, SRC, OUT = sys.argv[1], sys.argv[2], sys.argv[3]

import transformers.models.qwen3.modeling_qwen3 as q3
from transformers import AutoModel, AutoTokenizer
tok = AutoTokenizer.from_pretrained(SRC)


def ids_for(text, L, query):
    t = f"Instruct: {INSTR}\nQuery:{text}" if query else text
    x = tok(t, add_special_tokens=False)["input_ids"][: L - 1] + [EOS]
    a = np.zeros((1, L), np.int32); a[0, :len(x)] = x
    return a, np.array([len(x) - 1], np.int32), x


def samples(L):
    """Queries for 64; real source files cut to ~L tokens for the longer lengths."""
    if L <= 64:
        return [(q, True) for q in ["where does the data room open the demo viewer", "function that publishes the app to vercel",
                                    "sql table for investor intro paths", "how are job events subscribed in mini apps",
                                    "retry backoff for cloud sync push", "which component renders the pitch deck slide carousel"]]
    root = "/tmp/pw-codesearch/src/core/tools"
    fs = sorted(os.path.join(root, f) for f in os.listdir(root) if f.endswith(".ts"))
    big = [f for f in fs if os.path.getsize(f) > L * 5][:6]
    return [(open(f).read(), False) for f in big]


def reference(texts, L):
    m = AutoModel.from_pretrained(SRC, dtype=torch.float32).eval(); R = []
    with torch.no_grad():
        for t, q in texts:
            _, _, x = ids_for(t, L, q)
            h = m(input_ids=torch.tensor([x])).last_hidden_state[0, -1]
            R.append(torch.nn.functional.normalize(h, dim=-1).numpy())
    return R


if mode == "convert":
    import coremltools as ct
    from coremltools.converters.mil.frontend.torch import ops as _ops
    _orig = _ops._cast
    def _cast(context, node, dtype, dtype_name):  # coremltools 9 + new torch: int() of a 1-element tensor
        x = context[node.inputs[0]]
        if x.val is not None and getattr(x.val, "shape", ()) and x.val.size == 1:
            context.add(_ops.mb.const(val=dtype(x.val.reshape(()).item()), name=node.name)); return
        return _orig(context, node, dtype, dtype_name)
    _ops._cast = _cast

    def rms(self, x):
        d = x.shape[-1]
        return self.weight * torch.nn.functional.layer_norm(torch.cat([x, -x], -1), (2 * d,), eps=self.variance_epsilon)[..., :d]
    q3.Qwen3RMSNorm.forward = rms
    base = AutoModel.from_pretrained(SRC, dtype=torch.float32, attn_implementation="eager").eval()

    class Embed(torch.nn.Module):
        def __init__(s, m): super().__init__(); s.m = m
        def forward(s, input_ids, last_index):
            # causal + right padding: the last real token never sees the padding, so no mask is needed
            h = s.m(input_ids=input_ids).last_hidden_state[0]           # [L, D]
            v = torch.index_select(h, 0, last_index)                     # [1, D]
            v = v / v.abs().amax(-1, keepdim=True)                       # pre-scale: squares stay < 1 in fp16
            return v / torch.sqrt((v * v).sum(-1, keepdim=True))

    os.makedirs(OUT, exist_ok=True)
    w = Embed(base).eval(); parts = {}
    for L in LENS:
        t0 = time.time()
        ex = (torch.zeros((1, L), dtype=torch.long), torch.tensor([L - 1], dtype=torch.long))
        tr = torch.jit.trace(w, ex)
        ml = ct.convert(tr, inputs=[ct.TensorType("input_ids", shape=(1, L), dtype=np.int32),
                                    ct.TensorType("last_index", shape=(1,), dtype=np.int32)],
                        outputs=[ct.TensorType("embedding")], compute_precision=ct.precision.FLOAT16,
                        minimum_deployment_target=ct.target.macOS15, convert_to="mlprogram", skip_model_load=True)
        if "--w8" in sys.argv:
            from coremltools.optimize.coreml import OpLinearQuantizerConfig, OptimizationConfig, linear_quantize_weights
            ml = linear_quantize_weights(ml, OptimizationConfig(global_config=OpLinearQuantizerConfig(mode="linear_symmetric", granularity="per_channel")))
        p = os.path.join(OUT, f"len_{L}.mlpackage"); ml.save(p); parts[L] = p
        out(what="converted", L=L, s=round(time.time() - t0)); del ml, tr
    desc = ct.utils.MultiFunctionDescriptor()
    for L, p in parts.items(): desc.add_function(p, src_function_name="main", target_function_name=f"len_{L}")
    desc.default_function_name = f"len_{LENS[0]}"
    final = os.path.join(OUT, "papr-embed-code-1-0.6b.mlpackage")
    ct.utils.save_multifunction(desc, final)
    sz = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(final) for f in fs)
    out(what="saved", path=final, mb=round(sz / 1e6))

elif mode == "bench":
    import coremltools as ct
    cu = sys.argv[4]
    for L in LENS:
        S = samples(L); R = reference(S, L)
        t0 = time.time(); m = ct.models.MLModel(OUT, compute_units=getattr(ct.ComputeUnit, cu), function_name=f"len_{L}"); load = time.time() - t0
        lat, cos = [], []
        for rep in range(3 if L >= 1024 else 5):
            for (t, q), r in zip(S, R):
                a, li, _ = ids_for(t, L, q)
                t1 = time.time(); v = m.predict({"input_ids": a, "last_index": li})["embedding"][0].astype(np.float32); lat.append(time.time() - t1)
                cos.append(float(v @ r))
        lat.sort()
        out(what="bench", cu=cu, L=L, n=len(S), load_s=round(load, 1), p50_ms=round(st.median(lat) * 1000, 1),
            p95_ms=round(lat[int(.95 * (len(lat) - 1))] * 1000, 1), cos_min=round(min(cos), 5), cos_mean=round(float(np.mean(cos)), 5),
            finite=bool(np.isfinite(cos).all()))
        del m
