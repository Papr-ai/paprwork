import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEvalTools, DISTRACTORS, loadEvalApps, scoreRouting, type EvalCase } from "./routingEval.js";

const dir = path.join(__dirname, "routing-eval");
const rawApps = JSON.parse(readFileSync(path.join(dir, "apps.json"), "utf8"));
const { cases } = JSON.parse(readFileSync(path.join(dir, "cases.json"), "utf8")) as { cases: EvalCase[] };

describe("routing eval fixtures", () => {
  const { tools, instructions } = buildEvalTools(loadEvalApps(rawApps));
  const names = new Set(tools.map((t) => t.name));

  it("every expected tool exists in what Claude would see", () => {
    for (const c of cases) for (const e of [c.expect].flat()) if (e) expect(names, c.prompt).toContain(e);
  });

  it("has enough negatives to measure over-triggering", () => {
    expect(cases.filter((c) => c.expect === null).length).toBeGreaterThanOrEqual(12);
    expect(new Set(cases.map((c) => c.prompt)).size).toBe(cases.length);
  });

  it("tool names and schemas are valid for the Messages API", () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(t.input_schema.type).toBe("object");
    }
    expect(tools.length).toBeLessThanOrEqual(64);
  });

  it("routed arm leads with intent and lists the apps; baseline does neither", () => {
    expect(tools.find((t) => t.name === "linkedin-outreach_draft")!.description).toMatch(
      /^Papr · LinkedIn Outreach\. Use when the user wants a LinkedIn connection note/,
    );
    expect(instructions).toContain("- Papr Books: the user wants to log a receipt");
    const base = buildEvalTools(loadEvalApps(rawApps, { stripRouting: true }));
    expect(base.tools.find((t) => t.name === "linkedin-outreach_draft")!.description).not.toMatch(/Use when/);
  });
});

describe("scoreRouting", () => {
  const papr = new Set(["a_status", "a_draft"]);
  it("separates misses, wrong Papr tools and false positives", () => {
    const cs: EvalCase[] = [
      { prompt: "p1", expect: "a_status" },
      { prompt: "p2", expect: ["a_draft", "a_status"] },
      { prompt: "p3", expect: "a_draft" },
      { prompt: "p4", expect: "a_draft" },
      { prompt: "n1", expect: null },
      { prompt: "n2", expect: null },
    ];
    const s = scoreRouting(
      cs,
      [
        { prompt: "p1", picked: "a_status" },
        { prompt: "p2", picked: "a_status" },
        { prompt: "p3", picked: "a_status" },
        { prompt: "p4", picked: DISTRACTORS[0].name },
        { prompt: "n1", picked: "a_draft" },
        { prompt: "n2", picked: "web_search" },
      ],
      papr,
    );
    expect(s).toMatchObject({ positives: 4, correct: 2, wrongPaprTool: 1, missed: 1, negatives: 2, falsePositives: 1, recall: 0.5, falsePositiveRate: 0.5 });
    expect(s.failures.map((f) => f.prompt)).toEqual(["p3", "p4", "n1"]);
  });
});
