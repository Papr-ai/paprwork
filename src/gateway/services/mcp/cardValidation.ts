/**
 * validate_app checks for Claude cards. Runs the exact build publish runs, so a card
 * that validates is a card that publishes. Silent for apps that haven't opted in.
 */
import { promises as fs } from "fs";
import path from "path";
import { parseAppBackendManifest } from "../appRuntime/appBackendManifest.js";
import { buildAppCards } from "./cardBuild.js";
import { parseClaudeAppConfig } from "./cardContract.js";

export interface CardIssue {
  file: string;
  line?: number;
  severity: "error" | "warning";
  message: string;
  rule: string;
}

const RULE = "claude-cards";
export const MAX_VIEWS_PER_APP = 6;

/** "card \"inbox\": Unknown … (cards/inbox.ts:3)" → file + line, so editors can jump to it. */
export function locateCardError(message: string, appDir: string): { file: string; line?: number } {
  const m = message.match(/\(([^()]+):(\d+)\)\s*$/);
  if (m) return { file: path.relative(appDir, path.resolve(appDir, m[1])) || m[1], line: Number(m[2]) };
  if (message.startsWith("metadata.claude")) return { file: "metadata.json" };
  if (message.includes("backend/manifest.json") || message.startsWith("backend manifest")) return { file: "backend/manifest.json" };
  return { file: "metadata.json" };
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Advice that keeps Claude's tool list useful; never blocks publish. */
async function designWarnings(appDir: string): Promise<CardIssue[]> {
  const out: CardIssue[] = [];
  const cfg = parseClaudeAppConfig(await readJson(path.join(appDir, "metadata.json")));
  if (!cfg) return out;
  const rawManifest = await readJson(path.join(appDir, "backend", "manifest.json"));
  let actions: ReturnType<typeof parseAppBackendManifest>["actions"] = {};
  try {
    actions = rawManifest ? parseAppBackendManifest(rawManifest).actions : {};
  } catch {
    /* reported by the build */
  }
  const views = Object.entries(cfg.views);
  const warn = (file: string, message: string): number => out.push({ file, severity: "warning", rule: RULE, message });
  if (views.length > MAX_VIEWS_PER_APP) {
    warn("metadata.json", `metadata.claude has ${views.length} views. Each becomes a Claude tool; keep it to ${MAX_VIEWS_PER_APP} or fewer so Claude picks the right one.`);
  }
  if (!cfg.summary) warn("metadata.json", "Add metadata.claude.summary (one sentence). Claude reads it to decide when to use this app.");
  for (const [name, view] of views) {
    const action = view.action ? actions[view.action] : undefined;
    if (view.kind === "approval" && action && action.effect !== "external") {
      warn("backend/manifest.json", `View "${name}" asks for approval, but "${view.action}" doesn't declare "effect": "external". Mark actions that reach outside Papr so every card gates them.`);
    }
    if ((view.kind === "action" || view.kind === "approval") && action && !action.description) {
      warn("backend/manifest.json", `Give "${view.action}" a short "description" (e.g. "Draft a reply"). It becomes the card's wording and Claude's tool description.`);
    }
  }
  return out;
}

export async function claudeCardIssues(appDir: string): Promise<CardIssue[]> {
  const result = await buildAppCards(appDir);
  if (!result.enabled) return [];
  const issues: CardIssue[] = result.errors.map((message) => ({ ...locateCardError(message, appDir), severity: "error", message, rule: RULE }));
  issues.push(...result.warnings.map((message) => ({ file: "metadata.json", severity: "warning" as const, message, rule: RULE })));
  issues.push(...(await designWarnings(appDir)));
  return issues;
}
