import { describe, expect, test } from "vitest";
import {
  ARCHITECT_TRIAGE_MARKER,
  LITE_ARCHITECT_BRIEF,
  buildArchitectTriageJevInput,
  decideArchitectTier,
  findVetoes,
  readTriageTierFromToolCall,
} from "../src/core/utils/architectTriage.js";
import { getToolById } from "../src/core/tools/index.js";
import { MEASURED_CORE_TOOL_IDS } from "../src/gateway/services/agent/toolDeferral.js";

const lowRisk = {
  background_work: { noul: 0.05 },
  multi_user: { noul: 0.1 },
  data_model: { noul: 0.1 },
  external_integrations: { noul: 0.05 },
};

describe("decideArchitectTier", () => {
  test("lite when Jev is confident and no risks", () => {
    const d = decideArchitectTier(
      { tier: { choice: "lite", probabilities: { lite: 0.9, full: 0.1 } }, ...lowRisk },
      "A one-page chart of my Q3 revenue CSV",
    );
    expect(d.tier).toBe("lite");
  });

  test("full when Jev unavailable (fail closed)", () => {
    expect(decideArchitectTier(null, "simple calculator").tier).toBe("full");
  });

  test("full below the lite confidence threshold", () => {
    const d = decideArchitectTier(
      { tier: { probabilities: { lite: 0.6, full: 0.4 } }, ...lowRisk },
      "a tip calculator",
    );
    expect(d.tier).toBe("full");
  });

  test("any Jev risk flag forces full", () => {
    const d = decideArchitectTier(
      { tier: { probabilities: { lite: 0.95 } }, ...lowRisk, multi_user: { noul: 0.8 } },
      "a simple board",
    );
    expect(d.tier).toBe("full");
    expect(d.reason).toContain("multi_user");
  });

  test("missing risk answer is treated as risky", () => {
    const { multi_user: _omit, ...partial } = lowRisk;
    const d = decideArchitectTier({ tier: { probabilities: { lite: 0.95 } }, ...partial }, "x");
    expect(d.tier).toBe("full");
  });

  test("keyword veto overrides a confident lite", () => {
    const d = decideArchitectTier(
      { tier: { probabilities: { lite: 0.99 } }, ...lowRisk },
      "dashboard that scrapes LinkedIn every morning",
    );
    expect(d.tier).toBe("full");
    expect(d.vetoes.length).toBeGreaterThan(0);
  });
});

describe("findVetoes", () => {
  test("catches multi-user and schedule language", () => {
    expect(findVetoes("admins can see all rows")).toContain("multi-user/access");
    expect(findVetoes("run a daily sync")).toContain("schedule/background");
  });
  test("leaves plain frontends alone", () => {
    expect(findVetoes("A landing page with a pricing table and dark mode")).toEqual([]);
  });
});

describe("jev input + brief", () => {
  test("asks tier choice + 4 risk noul questions", () => {
    const { questions } = buildArchitectTriageJevInput("chart app");
    expect(questions.tier.type).toBe("choice");
    expect(Object.values(questions).filter((q) => q.type === "noul")).toHaveLength(4);
  });
  test("lite brief carries design directive and escalation rule", () => {
    expect(LITE_ARCHITECT_BRIEF).toContain("EMPTY");
    expect(LITE_ARCHITECT_BRIEF).toContain("product-architect");
    expect(LITE_ARCHITECT_BRIEF).toContain("Less is more");
  });
});

describe("readTriageTierFromToolCall", () => {
  const result = JSON.stringify({ success: true, data: { [ARCHITECT_TRIAGE_MARKER]: "lite" } });
  test("direct call", () => {
    expect(readTriageTierFromToolCall({ name: "architect_triage", result })).toBe("lite");
  });
  test("via run_deferred_tool with double-encoded result", () => {
    expect(
      readTriageTierFromToolCall({
        name: "run_deferred_tool",
        args: { tool_name: "architect_triage" },
        result: JSON.stringify({ success: true, data: { result } }),
      }),
    ).toBe("lite");
  });
  test("ignores other tools", () => {
    expect(readTriageTierFromToolCall({ name: "jev_decide", result })).toBeNull();
  });
});

describe("registration", () => {
  test("tool registered and never deferred", () => {
    expect(getToolById("architect_triage")).toBeDefined();
    expect(MEASURED_CORE_TOOL_IDS).toContain("architect_triage");
  });
});
