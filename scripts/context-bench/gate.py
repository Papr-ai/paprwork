"""Context Bench gate: compare a run against baseline.json, print a markdown table, exit 1 on regression.

A gated arm regresses when its hits at the gated K fall more than `tolerance` below baseline, or the tokens it hands the
agent grow more than 15%. Latency (and so the latency term of retrieval loss) is reported, not gated: runner and
network noise move it by hundreds of ms between identical runs. Update baseline.json only in a PR that is meant to move the numbers, and say why.
usage: gate.py <results.json> [more results.json ...] --baseline baseline.json [--report report.md]
"""
import json, sys

args = sys.argv[1:]
base_path = args[args.index("--baseline") + 1]
report = args[args.index("--report") + 1] if "--report" in args else None
files = [a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or not args[i - 1].startswith("--"))]
rows = [r for f in files for r in json.load(open(f))]
base = json.load(open(base_path))
idx = {(r["method"], r["expand"], r["K"]): r for r in rows}

lines = ["## Context Bench", "", "| Arm | K | Hits | Baseline | p95 ms | Tokens | Loss | Status |", "|---|---|---|---|---|---|---|---|"]
failed = []
for g in base["gated"]:
    key = (g["method"], g["expand"], g["K"])
    r = idx.get(key)
    if r is None and g.get("optional"):
        lines.append(f"| {g['method']} ({g['expand']}) | {g['K']} | skipped | {g['hits']} | | | | ⏭ needs the workspace key |")
        continue
    if r is None:
        lines.append(f"| {g['method']} ({g['expand']}) | {g['K']} | missing | {g['hits']} | | | | ❌ not run |")
        failed.append(key)
        continue
    tol = g.get("tolerance", base.get("tolerance", 2))
    bad = r["hits"] < g["hits"] - tol or ("tokens" in g and r["tokens"] > g["tokens"] * 1.15)
    if bad:
        failed.append(key)
    lines.append(f"| {g['method']} ({g['expand']}) | {g['K']} | {r['hits']}/{r['n']} | {g['hits']} | {r['p95_ms']} | "
                 f"{r['tokens']} | {r['loss']:.3f} (base {g['loss']:.3f}) | {'❌ regressed' if bad else '✅'} |")
lines += ["", "Retrieval loss = −log10(Hit@K) + 0.5·p95/100 ms + 0.01·tokens/1k. Lower is better."]
out = "\n".join(lines)
print(out)
if report:
    open(report, "w").write(out + "\n")
sys.exit(1 if failed else 0)
