/**
 * Routing eval: does Claude pick the right Papr tool for real prompts — and stay quiet
 * when it shouldn't fire?
 *
 * We hand the model exactly what Claude sees from our connector (tool names, descriptions,
 * input schemas, server instructions) next to typical tools from other connectors, then
 * score the first tool it calls. Runner: scripts/mcp-routing-eval.ts.
 */
import { z } from "zod";
import { appTitle, inputSchemaToZodShape, planAppTools } from "./appTools.js";
import type { ClaudeApp } from "./catalog.js";
import { parseCardsManifest } from "./catalog.js";
import { buildInstructions } from "./routing.js";
import { MCP_INSTRUCTIONS } from "./server.js";

export interface EvalCase {
  prompt: string;
  /** Tool name, acceptable names, or null = no Papr tool should fire. */
  expect: string | string[] | null;
}

export interface EvalTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface EvalPick {
  prompt: string;
  picked: string | null;
}

/** Tools from other connectors a real Claude user has, so Papr competes for attention. */
export const DISTRACTORS: EvalTool[] = [
  ["web_search", "Search the web for current information.", { query: { type: "string" } }],
  ["gmail_send_email", "Send an email from the user's Gmail.", { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }],
  ["gmail_search", "Search the user's Gmail messages.", { query: { type: "string" } }],
  ["calendar_list_events", "List events on the user's Google Calendar for a date range.", { start: { type: "string" }, end: { type: "string" } }],
  ["calendar_create_event", "Create an event on the user's Google Calendar.", { title: { type: "string" }, start: { type: "string" } }],
  ["notion_search", "Search pages in the user's Notion workspace.", { query: { type: "string" } }],
  ["drive_search", "Search files in the user's Google Drive.", { query: { type: "string" } }],
].map(([name, description, properties]) => ({
  name: name as string,
  description: description as string,
  input_schema: { type: "object", properties: properties as Record<string, unknown> },
}));

const PAPR_STATIC: EvalTool[] = [
  {
    name: "papr_list_apps",
    description: "List the user's Papr apps that can open as cards in this chat, with the tool for each card.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "papr_continue_on_mac",
    description:
      "Give the user a one-time link that opens Papr on their Mac, signed in, optionally at a specific app. " +
      "Use when they want to build or edit an app, or run something that needs their Mac. The link works once, for 10 minutes.",
    input_schema: { type: "object", properties: { namespaceId: { type: "string" }, slug: { type: "string" } } },
  },
];

/** Fixture apps → ClaudeApp, optionally stripping routing fields (the "before" arm). */
export function loadEvalApps(raw: Array<Record<string, unknown>>, opts: { stripRouting?: boolean } = {}): ClaudeApp[] {
  return raw.map((a, i) => {
    const cards = structuredClone(a.cards) as Record<string, unknown>;
    if (opts.stripRouting) {
      delete cards.whenToUse;
      delete cards.examples;
      for (const v of Object.values(cards.views as Record<string, Record<string, unknown>>)) {
        delete v.whenToUse;
        delete v.examples;
      }
    }
    const parsed = parseCardsManifest(cards);
    if (!parsed) throw new Error(`fixture app ${String(a.slug)} has no valid cards`);
    return {
      appId: `eval-${i}`,
      namespaceId: "nsEval",
      slug: String(a.slug),
      name: a.name as string | undefined,
      description: a.description as string | undefined,
      cards: parsed,
    };
  });
}

export function buildEvalTools(apps: ClaudeApp[]): { tools: EvalTool[]; instructions: string } {
  const papr = planAppTools(apps).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(z.object(inputSchemaToZodShape(t.input, t.requireInput)), { io: "input" }) as Record<string, unknown>,
  }));
  return {
    tools: [...papr, ...PAPR_STATIC, ...DISTRACTORS],
    instructions: buildInstructions(MCP_INSTRUCTIONS, apps, appTitle),
  };
}

export const isPaprTool = (name: string | null, paprNames: Set<string>): boolean => !!name && paprNames.has(name);

export interface EvalScore {
  positives: number;
  correct: number;
  /** Positives where a Papr tool fired but the wrong one. */
  wrongPaprTool: number;
  /** Positives where no Papr tool fired. */
  missed: number;
  negatives: number;
  /** Negatives where a Papr tool fired (the expensive failure). */
  falsePositives: number;
  recall: number;
  falsePositiveRate: number;
  failures: Array<{ prompt: string; expected: string; picked: string | null }>;
}

export function scoreRouting(cases: EvalCase[], picks: EvalPick[], paprNames: Set<string>): EvalScore {
  const byPrompt = new Map(picks.map((p) => [p.prompt, p.picked]));
  const s: EvalScore = { positives: 0, correct: 0, wrongPaprTool: 0, missed: 0, negatives: 0, falsePositives: 0, recall: 0, falsePositiveRate: 0, failures: [] };
  for (const c of cases) {
    const picked = byPrompt.get(c.prompt) ?? null;
    if (c.expect === null) {
      s.negatives++;
      if (isPaprTool(picked, paprNames)) {
        s.falsePositives++;
        s.failures.push({ prompt: c.prompt, expected: "(no Papr tool)", picked });
      }
      continue;
    }
    s.positives++;
    const ok = (Array.isArray(c.expect) ? c.expect : [c.expect]).includes(picked ?? "");
    if (ok) s.correct++;
    else {
      if (isPaprTool(picked, paprNames)) s.wrongPaprTool++;
      else s.missed++;
      s.failures.push({ prompt: c.prompt, expected: [c.expect].flat().join(" | "), picked });
    }
  }
  s.recall = s.positives ? s.correct / s.positives : 1;
  s.falsePositiveRate = s.negatives ? s.falsePositives / s.negatives : 0;
  return s;
}
