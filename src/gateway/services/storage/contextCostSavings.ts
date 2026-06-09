import type Database from "better-sqlite3";
import { calculateCost } from "../CostCalculation.js";

const DEFAULT_MODEL = "gpt-5.2";

interface MessageCostRow {
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number | null;
  cost: number | null;
  hypothetical_prompt_tokens: number | null;
}

export interface ModelAwareCostSavings {
  actualCost: number;
  hypotheticalCostWithoutOptimizations: number;
  lifetimeCostSaved: number;
}

/** Estimate $ saved using each message's model pricing and stored footprint. */
export function computeModelAwareCostSavings(
  db: Database.Database,
  inflationRatio: number,
): ModelAwareCostSavings {
  const rows = db
    .prepare(
      `SELECT model, prompt_tokens, completion_tokens, cost, hypothetical_prompt_tokens
       FROM messages
       WHERE role = 'assistant' AND prompt_tokens > 0`,
    )
    .all() as MessageCostRow[];

  let actualCost = 0;
  let hypotheticalCost = 0;

  for (const row of rows) {
    const model = row.model ?? DEFAULT_MODEL;
    const promptTokens = row.prompt_tokens;
    const completionTokens = row.completion_tokens ?? 0;
    const storedCost = row.cost ?? 0;

    actualCost +=
      storedCost > 0
        ? storedCost
        : calculateCost(model, promptTokens, completionTokens);

    const hypotheticalPrompt =
      row.hypothetical_prompt_tokens ??
      Math.round(promptTokens * Math.max(1, inflationRatio));

    hypotheticalCost += calculateCost(
      model,
      hypotheticalPrompt,
      completionTokens,
    );
  }

  return {
    actualCost,
    hypotheticalCostWithoutOptimizations: hypotheticalCost,
    lifetimeCostSaved: Math.max(0, hypotheticalCost - actualCost),
  };
}
