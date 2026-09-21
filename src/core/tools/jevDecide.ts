/**
 * jev_decide — typed System One decisions via TypeSafe Jev.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ToolResult } from "../types/index.js";
import {
  JEV_DEFAULT_MODEL,
  JEV_KEY_NAME,
  normalizeQuestionType,
  type JevQuestion,
  type JevState,
} from "./jevClient.js";
import { evaluateJevWithAuth } from "./jevAuth.js";

const questionSchema = z
  .object({
    type: z
      .string()
      .describe("noul (yes/no), choice, or score. boolean is accepted as noul."),
    instructions: z
      .string()
      .min(1)
      .describe("The judgment to make about state"),
    criteria: z
      .union([z.record(z.string(), z.string().nullable()), z.array(z.string())])
      .optional()
      .describe(
        "choice: map of option -> definition. score: ordered rubric levels. optional for noul.",
      ),
  })
  .superRefine((value, ctx) => {
    try {
      normalizeQuestionType(value.type);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
        path: ["type"],
      });
    }
  });

const inputSchema = z.object({
  state: z
    .union([
      z.string().min(1),
      z.record(z.string(), z.unknown()),
      z.array(z.unknown()),
    ])
    .describe(
      "Only the text or JSON needed for the questions. Do not dump the full chat.",
    ),
  questions: z
    .record(z.string(), questionSchema)
    .describe("Named questions evaluated in one Jev call"),
  model: z
    .string()
    .optional()
    .describe(`Jev model id. Defaults to ${JEV_DEFAULT_MODEL}`),
});

type JevDecideArgs = z.infer<typeof inputSchema>;

function unwrapContext(input: JevDecideArgs | { context?: JevDecideArgs }): JevDecideArgs {
  if (input && typeof input === "object" && "context" in input) {
    return input.context ?? (input as JevDecideArgs);
  }
  return input as JevDecideArgs;
}

function toJevQuestions(
  questions: JevDecideArgs["questions"],
): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  for (const [key, raw] of Object.entries(questions)) {
    const type = normalizeQuestionType(raw.type);
    if (type === "noul") {
      out[key] = {
        type: "noul",
        instructions: raw.instructions,
        criteria: Array.isArray(raw.criteria) ? undefined : raw.criteria,
      };
      continue;
    }
    if (type === "choice") {
      if (!raw.criteria || Array.isArray(raw.criteria)) {
        throw new Error(
          `Question '${key}' (choice) requires criteria as an object of options`,
        );
      }
      out[key] = {
        type: "choice",
        instructions: raw.instructions,
        criteria: raw.criteria,
      };
      continue;
    }
    if (!Array.isArray(raw.criteria)) {
      throw new Error(
        `Question '${key}' (score) requires criteria as an ordered string array`,
      );
    }
    out[key] = {
      type: "score",
      instructions: raw.instructions,
      criteria: raw.criteria,
    };
  }
  return out;
}

export const jevDecideTool = createTool({
  id: "jev_decide",
  description:
    "Ask TypeSafe Jev for typed decisions about a state. Jev does not write text. " +
    "Use it for classification, routing, scoring, and yes/no judgments that code can branch on. " +
    "Returns calibrated probabilities and confidence. Prefer this over asking the chat model to classify. " +
    "Do not use Jev to generate emails, summaries, or code. " +
    "No Vercel AI SDK or experimental_evaluate — plain HTTP System One API. " +
    "Auth: Papr login (routes via memory server proxy) OR " +
    `${JEV_KEY_NAME} in Settings → Custom API Keys. ` +
    "Before first use in a task, read_skill({ skillId: \"preloaded-jev-decisions\" }). " +
    "If neither auth is available, call request_key or prompt Papr login. " +
    "For recurring classification, create a node/python job that calls evaluateJev / the TypeSafe endpoint; " +
    "do not invent a one-off curl schema. " +
    "Example: jev_decide({ state: 'Charged twice, need refund', questions: { " +
    "queue: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'refunds', technical: 'bugs' } }, " +
    "urgent: { type: 'noul', instructions: 'Time-sensitive?' } } })",
  inputSchema,
  execute: async (inputData): Promise<ToolResult> => {
    const args = unwrapContext(
      inputData as JevDecideArgs | { context?: JevDecideArgs },
    );
    const startTime = performance.now();

    try {
      let result;
      try {
        result = await evaluateJevWithAuth({
          state: args.state as JevState,
          questions: toJevQuestions(args.questions),
          model: args.model,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "JEV_AUTH_MISSING") {
          return {
            success: false,
            error:
              "Jev is not configured. Sign in with Papr (Settings → AI Models) to use the Papr proxy, " +
              `or call request_key({ name: "${JEV_KEY_NAME}", ` +
              `description: "TypeSafe Jev API key for typed decisions", ` +
              `sourceUrl: "https://console.typesafe.ai", permission: "always" }).`,
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }
        throw error;
      }

      return {
        success: true,
        data: {
          model: result.model,
          answers: result.answers,
          usage: result.usage,
          authMode: result.authMode,
          guidance:
            "Treat probabilities as probabilities. Auto-act only at high confidence (e.g. noul ≥ 0.85); " +
            "0.6–0.85 → clarify; below 0.6 → ask the user. Do not quote Jev as an oracle.",
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

export const jevTools = [jevDecideTool];
