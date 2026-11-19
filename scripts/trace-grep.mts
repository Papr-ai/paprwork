// Debug tool: trace one agent grep through the hybrid code-search path, stage by stage, with timings.
// Runs the real bash-tool code (grep + on-device papr-embed-code + memory search + v2 ranking + Jev rerank) outside the
// app. Only the LLM's decision to grep is simulated.
//   PAPR_CODE_EMBED_DATA_DIR=<copy of <PAPR_HOME>/data with models/ and code-embed/index.db> \
//   PAPR_CODE_EMBED_CONTEXT=0 PAPR_CODE_EMBED_CLOUD_SYNC=0 PAPR_API_KEY=... [PAPR_MEMORY_SERVER_URL=https://memory.papr.ai] \
//   npx tsx scripts/trace-grep.mts <appDir> "<pattern>" "<user request>"
// Use a copy of the index: the running app holds the live one. Network calls made with fetch (Jev) are logged; the
// memory search goes through the Papr SDK and only shows as the "[Bash Tool] Detected grep" line.
import { execSync } from "child_process";
import { executeBashCommand } from "../src/core/tools/bash.js";
import { getCodeEmbedRuntime, deviceHitsForGrep } from "../src/core/tools/codeEmbed/runtime.js";
import { runWithToolContext } from "../src/core/tools/context.js";

const [appDir, pattern, userRequest] = process.argv.slice(2) as [string, string, string];
const t0 = Date.now();
const at = () => `+${String(Date.now() - t0).padStart(5)} ms`;
const log = (s: string) => console.log(`${at()}  ${s}`);
const helperCpu = () => { try { return execSync("ps -Ao time=,command= | grep '[p]apr-embed-coreml/build' | head -1").toString().trim().split(/\s+/)[0]; } catch { return "-"; } };

log(`0. LLM (agent) decides to search; user said: "${userRequest}"`);
log(`1. agent calls bash tool: grep -rn "${pattern}" ${appDir.split("/").slice(-2).join("/")}`);

const rt = (await getCodeEmbedRuntime())!;
log(`2. on-device runtime: tier=${rt.tier}, loading embedder (Neural Engine first)...`);
await rt.embedder();
for (let i = 0; i < 120 && rt.backend === "none"; i++) await new Promise((r) => setTimeout(r, 500));
const info: any = rt.info();
log(`   backend=${rt.backend} neuralEngine=${JSON.stringify(info.neuralEngine)} chunks=${info.chunks}`);

const cpu0 = helperCpu();
let t = Date.now();
const dev = await deviceHitsForGrep(appDir, pattern);
log(`3. query embedded on ${dev.backend} + cosine over local index: ${Date.now() - t} ms, ${dev.hits.length} hits (helper CPU ${cpu0} -> ${helperCpu()})`);
for (const h of dev.hits.slice(0, 5)) console.log(`             ${h.score.toFixed(3)}  ${h.path.split("/").slice(-1)[0]}:${h.lineStart}-${h.lineEnd}`);

// Log every network call the tool makes (memory search, Jev) with its timing.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const s = Date.now(); const url = String(u?.url ?? u);
  const label = url.includes("typesafe") || url.includes("systemone") ? "5. Jev rerank" : url.includes("/memory/search") || url.includes("/v1/memory") ? "   memory search (cloud summaries)" : "   net";
  try { const r = await realFetch(u, init); log(`${label}: HTTP ${r.status} in ${Date.now() - s} ms  ${url.replace(/^https?:\/\/[^/]+/, "")}`); return r; }
  catch (e) { log(`${label}: FAILED after ${Date.now() - s} ms (${(e as Error).message})`); throw e; }
}) as typeof fetch;

t = Date.now();
log(`4. full bash tool run: grep + device hits + memory search + v2 ranking + Jev, in parallel where possible`);
const r: any = await runWithToolContext("trace", () => executeBashCommand({ command: `grep -rn "${pattern}" ${appDir}`, timeout: 30_000 } as any), { userMessage: userRequest } as any);
const out = String(r?.data?.stdout ?? r?.error ?? "");
log(`6. tool result back to the LLM after ${Date.now() - t} ms (${out.length} chars). Head:`);
console.log(out.split("=== Grep Results")[0]!.split("\n").map((l) => "             " + l).join("\n"));
await rt.close();
process.exit(0);
