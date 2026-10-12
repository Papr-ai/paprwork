/**
 * Jev labels each chat's kind of work once, then the label is cached on disk.
 *
 * Only chats worth labelling get a call (the most expensive unlabelled ones,
 * a few per page load), so the long tail stays "not classified yet" rather
 * than costing a Jev call per one-turn chat. Labels never change after they
 * are written: a chat that drifts topic keeps its first label.
 */

import * as fs from "fs";
import * as path from "path";
import { getPaprDataDir } from "../../../core/utils/paprRoot.js";

export const WORK_TYPES: Record<string, string> = {
  Building: "Writing, fixing or shipping software: apps, jobs, code changes, debugging, tests.",
  Design: "Visual or UX design: layouts, prototypes, icons, branding, page redesigns.",
  Strategy: "Business thinking: pricing, positioning, planning, fundraising, decisions.",
  Research: "Learning or investigating: reading docs, comparing tools, analysis, explainers.",
  Marketing: "Content for an audience: posts, videos, launch material, SEO, copy.",
  Sales: "Selling: outreach, prospects, decks, CRM, customer conversations.",
  Operations: "Running things: data cleanup, admin, scheduling, reports, personal tasks.",
};

interface Store {
  version: 1;
  labels: Record<string, string>;
}

function storePath(): string {
  return path.join(getPaprDataDir(), "agents-work-types.json");
}

export function loadWorkTypes(): Map<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Store;
    return new Map(Object.entries(raw.labels ?? {}));
  } catch {
    return new Map();
  }
}

function save(labels: Map<string, string>): void {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, labels: Object.fromEntries(labels) }, null, 2));
  fs.renameSync(tmp, p);
}

let inFlight: Promise<void> | null = null;

/**
 * Label up to `max` chats, most expensive first. Fire-and-forget from the
 * overview read; the next load shows the new labels.
 */
export function classifyChatsInBackground(
  candidates: Array<{ id: string; title: string; summary: string | null; cost: number }>,
  max = 6,
): void {
  if (inFlight) return;
  const labels = loadWorkTypes();
  const todo = candidates
    .filter((c) => !labels.has(c.id) && c.cost >= 5)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, max);
  if (todo.length === 0) return;

  inFlight = (async () => {
    const { evaluateJevWithAuth } = await import("../../../core/tools/jevAuth.js");
    for (const chat of todo) {
      try {
        const state = `Chat title: ${chat.title || "Untitled"}\nSummary: ${(chat.summary ?? "").slice(0, 1200)}`;
        const res = await evaluateJevWithAuth({
          state,
          questions: {
            kind: {
              type: "choice",
              instructions: "Which kind of work was this chat mostly about?",
              criteria: WORK_TYPES,
            },
          },
          timeoutMs: 20_000,
        });
        const choice = (res.answers.kind as { choice?: string } | undefined)?.choice;
        if (choice && WORK_TYPES[choice]) labels.set(chat.id, choice);
      } catch (error) {
        console.warn(
          "[AgentsOverview] Work-type classification skipped:",
          error instanceof Error ? error.message : error,
        );
        break;
      }
    }
    save(labels);
  })().finally(() => {
    inFlight = null;
  });
}
