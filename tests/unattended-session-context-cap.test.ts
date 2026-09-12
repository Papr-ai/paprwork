import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeHistoryTokenBudget,
  DEFAULT_SESSION_CONTEXT_LIMIT,
  MIN_CONTEXT_LIMIT,
  resolveEffectiveContextWindow,
} from "../src/gateway/services/agent/contextBudget.js";

/**
 * Background job sessions were the largest requests we made, because they were
 * the only ones nobody capped.
 *
 * Interactive chats carry a user-chosen `contextLimit` from the composer
 * (Enhancement 77). Job sessions have no user to choose one, so every
 * `AgentConfigInternal` built for a job left it unset — and an unset cap means
 * `resolveEffectiveContextWindow` returns the model's *advertised* window, 1M
 * on opus-5. Measured against the same models in the same database:
 *
 *   interactive, 200K cap  -> history budget  15,971, avg 104,007 tok/request
 *   interactive, 400K cap  -> history budget 124,637, avg 102,175 tok/request
 *   job, uncapped (1M)     -> history budget 746,637, avg 216,617 tok/request
 *                             peaking at 290,629
 *
 * A 47x budget gap, and 2.1x the tokens per request.
 *
 * Two things worth stating because they shape what this fix is and is not:
 *
 *  - The leak is mid-turn, not historical. A job session is a fresh chat id
 *    (`job:{jobId}:{runId}`) with no prior conversation, so there is nearly no
 *    history to trim. The 746K budget was permitting unbounded accumulation of
 *    *tool results* inside one long turn.
 *  - It is not a price-tier bug. Anthropic bills the full 1M window at standard
 *    rates ("a 900k-token request is billed at the same per-token rate as a
 *    9k-token request"), so there is no premium threshold to model in
 *    CostCalculation.ts. The saving is tokens not sent, and the quality gain is
 *    from staying inside the range where long-context retrieval still works.
 */

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO, relativePath), "utf-8");
}

describe("job session context cap — value", () => {
  it("matches the interactive default rather than the advertised window", () => {
    expect(DEFAULT_SESSION_CONTEXT_LIMIT).toBe(200_000);
  });

  it("sits above the floor, so the budget does not clamp to 8K", () => {
    // Below MIN_CONTEXT_LIMIT the cap is raised to it anyway, which would make
    // the constant a lie about what jobs actually get.
    expect(DEFAULT_SESSION_CONTEXT_LIMIT).toBeGreaterThanOrEqual(
      MIN_CONTEXT_LIMIT,
    );
  });
});

describe("job session context cap — effect on the budget", () => {
  /**
   * The tool-schema estimate recorded alongside the budgets in the database.
   * Using it reproduces all three measured figures exactly — 746,637 uncapped,
   * 66,637 for a job at the 200K cap, 15,971 for an interactive chat at the
   * same cap — so these assertions are pinned to observed reality rather than
   * to the formula restated.
   */
  const TOOL_TOKENS = 87_363;

  it("narrows a 1M model to the job cap", () => {
    expect(
      resolveEffectiveContextWindow(
        "anthropic",
        "claude-opus-5",
        DEFAULT_SESSION_CONTEXT_LIMIT,
      ),
    ).toBe(200_000);
  });

  it("cuts the uncapped job history budget by more than an order of magnitude", () => {
    const uncapped = computeHistoryTokenBudget({
      provider: "anthropic",
      modelId: "claude-opus-5",
      toolTokenEstimate: TOOL_TOKENS,
      maxOutputTokens: 16_000,
    });
    const capped = computeHistoryTokenBudget({
      provider: "anthropic",
      modelId: "claude-opus-5",
      toolTokenEstimate: TOOL_TOKENS,
      maxOutputTokens: 16_000,
      contextLimit: DEFAULT_SESSION_CONTEXT_LIMIT,
    });

    // The regression we are guarding, to the token: 746,637 is the uncapped
    // budget recorded against every job turn in the database.
    expect(uncapped).toBe(746_637);
    expect(capped).toBeLessThan(uncapped / 10);
  });

  it("gives a job more history room than an interactive chat at the same cap", () => {
    // Not a bug, and worth pinning so nobody "fixes" it. The two differ only in
    // the output reserve: an interactive config carries the model's advertised
    // max output (128K on opus-5) from the model table, which
    // `resolveOutputReserve` caps at a third of the window (66,666), leaving
    // 15,971 for history. A job config leaves `maxTokens` unset, so the reserve
    // is the 16K default and history gets 66,637.
    //
    // That asymmetry points the right way: a job session is a fresh chat with no
    // conversation to carry, but it does accumulate tool results across one long
    // turn — so the spare room lands where a job actually needs it.
    const asJob = computeHistoryTokenBudget({
      provider: "anthropic",
      modelId: "claude-opus-5",
      toolTokenEstimate: TOOL_TOKENS,
      maxOutputTokens: 16_000,
      contextLimit: DEFAULT_SESSION_CONTEXT_LIMIT,
    });
    const asInteractiveChat = computeHistoryTokenBudget({
      provider: "anthropic",
      modelId: "claude-opus-5",
      toolTokenEstimate: TOOL_TOKENS,
      maxOutputTokens: 128_000,
      contextLimit: 200_000,
    });

    expect(asJob).toBeGreaterThan(asInteractiveChat);
    expect(asJob).toBe(66_637);
    expect(asInteractiveChat).toBe(15_971); // the figure measured on the real turn
  });

  it("does not collapse to the 8K floor (Issue 89's failure mode)", () => {
    const budget = computeHistoryTokenBudget({
      provider: "anthropic",
      modelId: "claude-opus-5",
      toolTokenEstimate: TOOL_TOKENS,
      maxOutputTokens: 16_000,
      contextLimit: DEFAULT_SESSION_CONTEXT_LIMIT,
    });
    // A cap that drives the budget negative clamps to 8,000 and silently stops
    // bounding anything. The job cap must sit clear of that.
    expect(budget).toBeGreaterThan(8_000);
  });

  it("cannot widen a model whose own window is smaller than the cap", () => {
    // A cap only ever shrinks. Asking for 200K on a 128K model must not lift it.
    expect(
      resolveEffectiveContextWindow(
        "openai",
        "definitely-not-a-real-model",
        DEFAULT_SESSION_CONTEXT_LIMIT,
      ),
    ).toBe(128_000);
  });
});

describe("job session context cap — static invariant", () => {
  it("every AgentConfigInternal in AgentService sets or inherits a contextLimit", () => {
    const content = read("src/gateway/services/AgentService.ts");
    const marker = "AgentConfigInternal = {";

    const offenders: string[] = [];
    let found = 0;
    let from = 0;
    for (;;) {
      const at = content.indexOf(marker, from);
      if (at === -1) break;
      from = at + marker.length;
      found++;

      // The object literal ends at the first line that closes it.
      const body = content.slice(at, content.indexOf("};", at));
      const line = content.slice(0, at).split("\n").length;

      // Either it sets the cap itself, or it spreads a config that already has
      // one (the OAuth -> API key retry path does the latter).
      const ok =
        body.includes("contextLimit") || /\.\.\.\s*config\b/.test(body);
      if (!ok) offenders.push(`line ${line}`);
    }

    // Guard the guard: if the marker stops matching, this test would pass with
    // nothing checked. There were four sites when it was written.
    expect(
      found,
      "found no AgentConfigInternal literals — has the construction shape changed?",
    ).toBeGreaterThanOrEqual(4);

    expect(
      offenders,
      `AgentConfigInternal built without a contextLimit at ${offenders.join(
        ", ",
      )}. An unset cap budgets against the model's advertised window (1M on ` +
        `opus-5), which is how background jobs came to be our largest requests. ` +
        `Set contextLimit: DEFAULT_SESSION_CONTEXT_LIMIT, or spread a config that has one.`,
    ).toEqual([]);
  });

  it("job configs reference the shared constant, not a literal", () => {
    const content = read("src/gateway/services/AgentService.ts");
    expect(content).toContain("DEFAULT_SESSION_CONTEXT_LIMIT");
    // A hand-written 200000 beside a job config would drift from the constant.
    expect(content).not.toMatch(/contextLimit:\s*200_?000/);
  });

  it("every other streamAgent caller that builds a config also caps it", () => {
    // The interactive path is exempt and must stay so: websocket/agent.ts
    // spreads the config the composer sent, which already carries the user's
    // cap. Everything else has no control to send one.
    const callers = [
      "src/gateway/services/appAgentChat/AppAgentChatRunService.ts",
      "src/gateway/services/SubAgentResponseTrigger.ts",
    ];

    for (const relativePath of callers) {
      const content = read(relativePath);
      expect(
        content,
        `${relativePath} streams an agent with a config it builds itself, but ` +
          `never sets contextLimit. Unset means the model's advertised window ` +
          `(1M on opus-5), which is the defect this file exists to guard.`,
      ).toContain("DEFAULT_SESSION_CONTEXT_LIMIT");
    }
  });

  it("the interactive path still forwards the user's own cap", () => {
    // If this ever stops spreading the incoming config, the composer's 200K /
    // 400K / 1M choice would be silently dropped (Enhancement 77).
    const content = read("src/gateway/websocket/agent.ts");
    expect(content).toMatch(/configInternal\s*=\s*\{\s*\n?\s*\.\.\.config/);
    // And it must not be overridden with the unattended default.
    expect(content).not.toContain("DEFAULT_SESSION_CONTEXT_LIMIT");
  });
});
