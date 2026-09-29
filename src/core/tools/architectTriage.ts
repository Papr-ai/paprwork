/**
 * architect_triage — Jev-routed choice between the full product-architect
 * sub-agent and a lite inline pass for simple frontends / reports.
 * Policy + rules live in ../utils/architectTriage.ts.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  ARCHITECT_TRIAGE_MARKER,
  ARCHITECT_TRIAGE_TOOL_ID,
  LITE_ARCHITECT_BRIEF,
  buildArchitectTriageJevInput,
  decideArchitectTier,
} from "../utils/architectTriage.js";

const inputSchema = z.object({
  request: z
    .string()
    .min(1)
    .describe("The user's app request in their words (1-3 sentences). Include what it shows/does and who uses it."),
  context: z
    .string()
    .optional()
    .describe("Known constraints: data sources, sharing, schedules, integrations. Omit if none."),
});

type Args = z.infer<typeof inputSchema>;

export const architectTriageTool = createTool({
  id: ARCHITECT_TRIAGE_TOOL_ID,
  description:
    "Call FIRST for every new mini-app, before delegate_task(product-architect). " +
    "Jev classifies the request: tier 'lite' (single-screen frontend, visualization, calculator, one-off analysis report — " +
    "returns design/frontend rules; you build directly and create_app is unlocked) or tier 'full' (jobs, schedules, shared DB, " +
    "multi-user/ACL, integrations — delegate to product-architect as usual). Fails closed to 'full'. " +
    "A lite pass unlocks create_app only; app-linked/scheduled/agent create_job still requires the full architect.",
  inputSchema,
  execute: async (input) => {
    const args = ((input as { context?: Args }).context ?? input) as Args;
    const requestText = `${args.request}\n${args.context ?? ""}`;
    let answers: Record<string, unknown> | null = null;
    let jevError: string | undefined;
    try {
      const { evaluateJevWithAuth } = await import("./jevAuth.js");
      const { state, questions } = buildArchitectTriageJevInput(args.request, args.context);
      const res = await evaluateJevWithAuth({ state, questions, timeoutMs: 15_000 });
      answers = res.answers;
    } catch (error) {
      jevError = error instanceof Error ? error.message : String(error);
    }

    const decision = decideArchitectTier(answers, requestText);
    const { loadBrandDesignContext } = await import(
      "../../gateway/services/brandDesignContext.js"
    );
    const brand = await loadBrandDesignContext();
    const next =
      decision.tier === "lite"
        ? "Write the 5-line lite brief in chat, then create_plan → create_app. No product-architect delegation needed."
        : 'list_sub_agents() → delegate_task({ useAgentId: "product-architect", task, context }) → wait → create_plan → create_app.';

    return {
      success: true,
      data: {
        [ARCHITECT_TRIAGE_MARKER]: decision.tier,
        tier: decision.tier,
        reason: decision.reason,
        liteProbability: Number(decision.liteProbability.toFixed(3)),
        risks: decision.risks,
        vetoes: decision.vetoes,
        ...(jevError ? { jevError } : {}),
        next,
        ...(decision.tier === "lite" ? { liteBrief: LITE_ARCHITECT_BRIEF } : {}),
        ...(brand
          ? {
              brandStatus: brand.status,
              brand: brand.block,
              ...(brand.askUser ? { askUserFirst: brand.askUser } : {}),
            }
          : {}),
      },
    };
  },
});

export const architectTriageTools = [architectTriageTool];
