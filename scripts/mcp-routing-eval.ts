/**
 * Papr × Claude routing eval.
 *
 *   ANTHROPIC_API_KEY=… npx tsx scripts/mcp-routing-eval.ts [--model claude-sonnet-4-5] [--arm both|routed|baseline] [--runs 1]
 *
 * Scenarios (combine freely):
 *   --scale   add 10 more realistic apps (routing-eval/filler-apps.json) so ~15 apps compete
 *   --opaque  rename the scored apps to codenames (atlas, orbit…), like users actually name apps
 *
 * Arms:
 *   baseline  fixture apps with whenToUse/examples stripped (PR 2 descriptions)
 *   routed    intent-first descriptions + server instructions (PR 3c)
 *
 * Reports recall on Papr prompts and the false-positive rate on prompts Papr must ignore.
 * Exit 1 if the routed arm falls below --min-recall (0.85) or above --max-fpr (0.05).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvalTools, loadEvalApps, scoreRouting, type EvalCase, type EvalPick, type EvalTool } from "../src/gateway/services/mcp/routingEval.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "../src/gateway/services/mcp/routing-eval");
const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};

const MODEL = arg("model", "claude-sonnet-4-5");
const ARM = arg("arm", "both");
const RUNS = Number(arg("runs", "1"));
const MIN_RECALL = Number(arg("min-recall", "0.85"));
const MAX_FPR = Number(arg("max-fpr", "0.05"));
const SCALE = process.argv.includes("--scale");
const OPAQUE = process.argv.includes("--opaque");
const CONCURRENCY = 6;
const CODENAMES: Record<string, string> = {
  "linkedin-outreach": "atlas",
  "papr-books": "orbit",
  "meetings-manager": "lumen",
  "competitor-watch": "sentinel",
  "hiring-pipeline": "harbor",
};
const rename = (tool: string): string => {
  for (const [slug, code] of Object.entries(CODENAMES)) if (tool.startsWith(`${slug}_`)) return code + tool.slice(slug.length);
  return tool;
};

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is required");
  process.exit(2);
}

// Claude.ai's own system prompt isn't public; this is a neutral stand-in plus our instructions.
const SYSTEM = (instructions: string) =>
  "You are Claude, a helpful assistant. The user has connected some tools. Use a tool only when it clearly helps; " +
  "otherwise answer directly.\n\n<connector name=\"Papr\">\n" + instructions + "\n</connector>";

async function pick(prompt: string, tools: EvalTool[], instructions: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM(instructions),
        tools,
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { content: Array<{ type: string; name?: string }> };
    return body.content.find((c) => c.type === "tool_use")?.name ?? null;
  }
}

async function runArm(arm: "baseline" | "routed", cases: EvalCase[], rawApps: Array<Record<string, unknown>>) {
  const apps = loadEvalApps(rawApps, { stripRouting: arm === "baseline" });
  const { tools, instructions } = buildEvalTools(apps);
  // Baseline = PR 2: static instructions, no app list.
  const instr = arm === "baseline" ? instructions.split("\n\nThis user already runs")[0] : instructions;
  const paprNames = new Set(tools.filter((t) => !t.name.match(/^(web_|gmail_|calendar_|notion_|drive_)/)).map((t) => t.name));
  const scores = [];
  for (let run = 0; run < RUNS; run++) {
    const picks: EvalPick[] = [];
    const queue = [...cases];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) picks.push({ prompt: c.prompt, picked: await pick(c.prompt, tools, instr) });
      }),
    );
    scores.push(scoreRouting(cases, picks, paprNames));
  }
  return { arm, tools: tools.length, scores };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  let { cases } = JSON.parse(readFileSync(path.join(fixtures, "cases.json"), "utf8")) as { cases: EvalCase[] };
  let rawApps = JSON.parse(readFileSync(path.join(fixtures, "apps.json"), "utf8")) as Array<Record<string, unknown>>;
  if (OPAQUE) {
    rawApps = rawApps.map((a) => {
      const code = CODENAMES[String(a.slug)];
      return code ? { ...a, slug: code, name: code[0].toUpperCase() + code.slice(1), description: undefined } : a;
    });
    cases = cases.map((c) => ({ ...c, expect: c.expect === null ? null : Array.isArray(c.expect) ? c.expect.map(rename) : rename(c.expect) }));
  }
  if (SCALE) {
    // Interleave so the scored apps aren't all at the top of the tool list.
    const filler = JSON.parse(readFileSync(path.join(fixtures, "filler-apps.json"), "utf8")) as Array<Record<string, unknown>>;
    rawApps = rawApps.flatMap((a, i) => [a, ...filler.slice(i * 2, i * 2 + 2)]);
  }
  const arms = ARM === "both" ? (["baseline", "routed"] as const) : ([ARM as "baseline" | "routed"] as const);
  console.log(`model=${MODEL} cases=${cases.length} runs=${RUNS} apps=${rawApps.length}${OPAQUE ? " opaque" : ""}${SCALE ? " scale" : ""}`);
  let routed: ReturnType<typeof scoreRouting> | undefined;
  for (const arm of arms) {
    const r = await runArm(arm, cases, rawApps);
    const recall = r.scores.reduce((a, s) => a + s.recall, 0) / r.scores.length;
    const fpr = r.scores.reduce((a, s) => a + s.falsePositiveRate, 0) / r.scores.length;
    const last = r.scores[r.scores.length - 1];
    console.log(`\n== ${arm} (${r.tools} tools)  recall ${pct(recall)}  false-positive ${pct(fpr)}  wrong-papr ${last.wrongPaprTool}  missed ${last.missed}`);
    for (const f of last.failures) console.log(`   ✗ "${f.prompt}"  expected ${f.expected}  got ${f.picked ?? "(none)"}`);
    if (arm === "routed") routed = { ...last, recall, falsePositiveRate: fpr };
  }
  if (routed && (routed.recall < MIN_RECALL || routed.falsePositiveRate > MAX_FPR)) {
    console.error(`\nFAIL: routed recall ${pct(routed.recall)} (min ${pct(MIN_RECALL)}), FPR ${pct(routed.falsePositiveRate)} (max ${pct(MAX_FPR)})`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
