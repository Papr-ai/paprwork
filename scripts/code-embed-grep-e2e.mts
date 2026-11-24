// Real end-to-end for the agent's grep path: real papr-embed-code (CoreML on the Neural Engine via the Swift helper,
// ONNX fallback), real background indexing of a real Papr app, and executeBashCommand's hybrid grep output.
//   PAPR_CODE_EMBED_DATA_DIR=<dir with models/> PAPR_CODE_EMBED_HELPER=<helper> npx tsx scripts/code-embed-grep-e2e.mts <appDir> "<pattern>" ["<pattern>"...]
import { executeBashCommand } from "../src/core/tools/bash.js";
import { getCodeEmbedRuntime } from "../src/core/tools/codeEmbed/runtime.js";

const [appDir, ...patterns] = process.argv.slice(2) as [string, ...string[]];
const t0 = Date.now();
const grep = async (p: string) => {
  const t = Date.now();
  const r: any = await executeBashCommand({ command: `grep -rn "${p}" ${appDir}`, timeout: 30_000 } as any);
  return { ms: Date.now() - t, out: String(r?.data?.stdout ?? r?.error ?? "") };
};

// 1. Cold: model not loaded, index empty. Grep must come back at normal speed with no device block.
const cold = await grep(patterns[0]!);
console.log(`COLD grep ${cold.ms} ms; device block: ${cold.out.includes("Semantic code search (papr-embed-code") ? "yes" : "no"}`);

// 2. Wait for the background load + index (what happens while the agent keeps working).
const rt = (await getCodeEmbedRuntime())!;
const root = (rt as any).roots.values().next().value as string;
for (let i = 0; i < 900; i++) {
  const s = rt.store.stats();
  if (rt.backend !== "none" && s.files > 0 && rt.store.pendingBlobs(root).length === 0) break;
  if (i === 899) console.log("  (gave up waiting)");
  if (i % 30 === 0) console.log(`  … ${rt.status}; files ${s.files}, pending ${rt.store.pendingBlobs(root).length}, chunks ${s.chunks}`);
  await new Promise((r) => setTimeout(r, 1000));
}
const st = rt.store.stats();
const indexMs = Date.now() - t0;
console.log(`INDEXED in ${((Date.now() - t0) / 1000).toFixed(1)} s: tier=${rt.tier} backend=${rt.backend} files=${st.files} chunks=${st.chunks} pending=${st.pending}`);

// 3. Warm greps: device block leads, pointer block uses it, grep results unchanged underneath.
for (const p of patterns) {
  const w = await grep(p);
  const block = w.out.split("=== Grep Results")[0]!;
  console.log(`\nWARM grep "${p}" ${w.ms} ms\n${block.split("\n").filter((l) => !l.startsWith("   ")).slice(0, 18).join("\n")}`);
}
// 4. Agent edits a file: the next grep finds it by its new content.
const fs = await import("fs");
const probe = `${appDir}/zz-e2e-probe.ts`;
fs.writeFileSync(probe, "// Reconciles Stripe invoices against the ledger and flags refunds that never settled.\nexport function reconcileStripeRefunds(){ return [] }\n");
rt.touch(root, true);
for (let i = 0; i < 60 && rt.store.pendingBlobs(root).length; i++) await new Promise((r) => setTimeout(r, 500));
const e = await grep("refunds that never settled");
console.log(`\nAFTER EDIT grep ${e.ms} ms: device block lists probe: ${/Semantic code search[\s\S]*zz-e2e-probe\.ts/.test(e.out.split("=== Grep Results")[0]!)}`);
fs.unlinkSync(probe);
console.log(`backend at end: ${rt.backend}; status: ${rt.status}`);
await rt.close();
process.exit(0);
