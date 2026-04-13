import { RecipeService } from "../src/gateway/services/jobs/RecipeService.js";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

const TEST_JOB_ID = "test-recipe-job-" + Date.now();
const JOB_DIR = path.join(os.homedir(), "Papr", "jobs", TEST_JOB_ID);

const SAMPLE_RECIPE = `# Execution Recipe: Test Job

## Intent
Monitor /r/rag for new posts and send personalized welcome DMs.

## Success Criteria
- [ ] New posts detected within the last 24 hours
- [ ] DM sent to each new poster
- [ ] No duplicate DMs sent

## Quality Rubric
| Dimension | Weight | Description |
|-----------|--------|-------------|
| Personalization | 35% | DM references the poster specific topic |
| Warmth | 25% | Friendly genuine tone |
| Accuracy | 40% | Correct information about the community |

## Anti-Patterns
- Never use generic copy-paste templates
- Never mention competing communities
- Never be pushy about scheduling

## Edge Cases
- If user has DMs disabled then skip and log reason
- If post is a crosspost then check original sub first
- If poster is a bot then skip silently

## Expected Output
A log of all DMs sent with poster username, post title, and DM content.
`;

let passed = 0, failed = 0;
function ok(cond: boolean, name: string) {
  if (cond) { console.log("  PASS", name); passed++; }
  else { console.log("  FAIL", name); failed++; }
}

async function main() {
  const svc = new RecipeService();
  await fs.mkdir(JOB_DIR, { recursive: true });

  try {
    console.log("\n--- Recipe CRUD ---");
    await svc.writeRecipe(TEST_JOB_ID, SAMPLE_RECIPE);
    ok((await svc.readRecipe(TEST_JOB_ID)) === SAMPLE_RECIPE, "write+read");
    ok((await svc.readRecipe("nope")) === null, "missing returns null");
    ok(await svc.hasRecipe(TEST_JOB_ID), "hasRecipe true");
    await svc.deleteRecipe(TEST_JOB_ID);
    ok(!(await svc.hasRecipe(TEST_JOB_ID)), "delete works");

    console.log("\n--- Recipe Parsing ---");
    const p = svc.parseRecipe(SAMPLE_RECIPE);
    ok(p.intent.includes("Monitor /r/rag"), "intent");
    ok(p.successCriteria.length === 3, "3 criteria");
    ok(p.qualityRubric.length === 3, "3 rubric dims");
    ok(p.qualityRubric.find(r => r.dimension === "Personalization")?.weight === 0.35, "weight 0.35");
    ok(p.qualityRubric.find(r => r.dimension === "Accuracy")?.weight === 0.40, "weight 0.40");
    ok(p.antiPatterns.length === 3, "3 anti-patterns");
    ok(p.edgeCases.length === 3, "3 edge cases");
    ok(p.expectedOutput.includes("log of all DMs"), "expected output");

    console.log("\n--- Evaluation Storage ---");
    await svc.writeRecipe(TEST_JOB_ID, SAMPLE_RECIPE);
    const ev = {
      runId: "run-001", jobId: TEST_JOB_ID, timestamp: new Date().toISOString(),
      overallScore: 0.85, passed: true,
      criteria: [{ name: "P", score: 0.9, weight: 0.35, passed: true, notes: "ok" }],
      summary: "good", antiPatternViolations: [] as string[],
      edgeCasesHandled: [] as string[], evaluatorModel: "test", durationMs: 100,
    };
    await svc.saveEvaluation(ev);
    const got = await svc.getEvaluation(TEST_JOB_ID, "run-001");
    ok(got?.overallScore === 0.85, "save+get eval");

    await svc.saveEvaluation({ ...ev, runId: "run-002", overallScore: 0.9, timestamp: "2026-01-02T00:00:00Z" });
    await svc.saveEvaluation({ ...ev, runId: "run-003", overallScore: 0.6, timestamp: "2026-01-03T00:00:00Z" });
    const list = await svc.listEvaluations(TEST_JOB_ID);
    ok(list.length === 3, "list 3 evals");
    ok(list[0].runId === "run-003", "newest first");
    ok((await svc.listEvaluations("nope")).length === 0, "empty for unknown");

    console.log("\n--- Prompt Builder ---");
    const prompt = svc.buildEvaluationPrompt(SAMPLE_RECIPE, p, "output", "logs");
    ok(prompt.includes("Execution Recipe Evaluator"), "has header");
    ok(prompt.includes("Personalization"), "has dimensions");
    ok(prompt.includes("0.35"), "has weights");

  } finally {
    await fs.rm(JOB_DIR, { recursive: true, force: true });
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
