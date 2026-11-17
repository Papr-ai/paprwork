// Manual end-to-end (needs a Papr login or PAPR_API_KEY + the on-device model): APP_DIR=<app folder> npx tsx scripts/curation-bench/e2e-jev.mts
// Runs the real bash tool grep inside a mini-app with the user message set, once with Jev and once with it off.
import { setToolContext } from "../../src/core/tools/context.js";
import { executeBashCommand } from "../../src/core/tools/bash.js";
import { deviceHitsForGrep } from "../../src/core/tools/codeEmbed/runtime.js";
const APP = process.env.APP_DIR!;
const ask = "In the architecture app, where are the diagram box colours (have / test / new / later) defined and rendered?";
// Warm: first search loads the model and indexes the app in the background.
for (let i = 0; i < 40; i++) {
  const r = await deviceHitsForGrep(APP, "diagram box status colour", 30_000);
  if (r.hits.length) { console.log(`warm after ${i + 1} tries: tier=${r.tier} backend=${r.backend} hits=${r.hits.length}`); break; }
  await new Promise((s) => setTimeout(s, 5_000));
}
setToolContext("e2e-jev", { userMessage: ask });
for (const mode of ["LIVE", "OFFLINE"]) {
  if (mode === "OFFLINE") process.env.PAPR_CODE_JEV_RERANK = "0";
  const t = Date.now();
  const r: any = await executeBashCommand({ command: `grep -rn "boxStatus" ${APP}` } as any);
  const out: string = r?.data?.stdout ?? "";
  console.log(`\n--- ${mode} in ${Date.now() - t} ms`);
  console.log(out.split(/=== (Semantic|Grep|Papr Memory)/)[0].slice(0, 1500));
}
process.exit(0);
