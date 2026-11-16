// Curation Bench gate: pass/fail a rank.mts result against the floor and the committed baseline.
//   tsx scripts/curation-bench/gate.mts <result.json> [--baseline scripts/curation-bench/baseline.json] [--min-miss 41]
// Exit 1 on failure and print a markdown report (the workflow posts it and opens an issue).
import * as fs from "fs";

export interface Summary { miss: { n: number; top10: number; harness: number; shown: number }; ctrl: { n: number; top10: number; harness: number; shown: number } }
export interface Baseline { miss: { harness: number }; ctrl: { harness: number } }

/** Floor on grep misses recovered; no group may drop more than `tolerance` rows below the baseline. */
export function gate(r: { summary: Summary }, o: { minMiss: number; baseline?: Baseline; tolerance: number }): { ok: boolean; reasons: string[] } {
  const s = r.summary;
  const reasons: string[] = [];
  if (s.miss.harness < o.minMiss) reasons.push(`${s.miss.harness} of ${s.miss.n} misses < ${o.minMiss}`);
  if (o.baseline) {
    if (s.miss.harness < o.baseline.miss.harness - o.tolerance)
      reasons.push(`misses ${s.miss.harness} < baseline ${o.baseline.miss.harness} - ${o.tolerance}`);
    if (s.ctrl.harness < o.baseline.ctrl.harness - o.tolerance)
      reasons.push(`controls ${s.ctrl.harness} < baseline ${o.baseline.ctrl.harness} - ${o.tolerance}`);
  }
  return { ok: reasons.length === 0, reasons };
}

if (process.argv[1]?.endsWith("gate.mts")) {
  const [file] = process.argv.slice(2) as [string];
  const flag = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  const bl = flag("--baseline");
  const baseline = bl ? (JSON.parse(fs.readFileSync(bl, "utf8")) as Record<string, Baseline>)[flag("--arm") ?? "local"] : undefined;
  const g = gate(r, { minMiss: Number(flag("--min-miss") ?? 41), baseline, tolerance: Number(flag("--tolerance") ?? 1) });
  const s = r.summary as Summary;
  console.log(`| Group | Rows | Semantic top 10 | Harness (top 10 + 2 also check) | Shown in grep output |\n|---|---|---|---|---|`);
  for (const k of ["miss", "ctrl"] as const)
    console.log(`| ${k === "miss" ? "Grep misses" : "Controls"} | ${s[k].n} | ${s[k].top10} | **${s[k].harness}** | ${s[k].shown} |`);
  console.log(g.ok ? "\nPASS" : `\nFAIL: ${g.reasons.join("; ")}`);
  process.exit(g.ok ? 0 : 1);
}
