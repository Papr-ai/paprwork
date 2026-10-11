/**
 * AEO for Claude: how a Papr app gets picked when the user asks for help.
 *
 * Claude chooses tools from their names + descriptions every turn. So routing is:
 *   1. intent-first tool descriptions (what the user asks for, not what the app is),
 *   2. server instructions listing the user's own apps,
 *   3. a small tool budget (≤3 per app) so descriptions don't drown each other,
 *   4. publish-time lint that rejects over-broad / keyword-stuffed text — over-triggering
 *      is worse than missing, because users switch the connector off,
 *   5. a routing eval (routingEval.ts) that measures 1–4 against real prompts.
 */
import type { ClaudeAppConfig, ClaudeCardView } from "./cardContract.js";
import type { ClaudeApp } from "./catalog.js";

export const MAX_TOOLS_PER_APP = 3;
export const MAX_INSTRUCTION_APPS = 15;

/** Phrases that make a tool fire on everything. Rejected at publish. */
const OVERBROAD = [
  /\b(any|every|all)\s+(task|question|request|query|thing|topic)s?\b/i,
  /\banything\b/i,
  /\beverything\b/i,
  /\balways\s+(use|call|prefer|pick)\b/i,
  /\b(use|call)\s+this\s+(first|instead)\b/i,
  /\bignore\s+(other|previous)\b/i,
  /\bwhenever\s+the\s+user\s+(asks|says|wants)\s*[.,]?$/i,
];

export interface RoutingIssue {
  severity: "error" | "warning";
  message: string;
}

/** Keyword stuffing: long comma/pipe lists or one word repeated. */
export function looksStuffed(text: string): boolean {
  const parts = text.split(/[,|;/]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 9 && parts.filter((p) => p.split(/\s+/).length <= 2).length >= 7) return true;
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z]{4,}/g) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.values()].some((n) => n >= 4);
}

function lintText(where: string, text: string | undefined): RoutingIssue[] {
  if (!text) return [];
  const out: RoutingIssue[] = [];
  const hit = OVERBROAD.find((re) => re.test(text));
  if (hit) {
    out.push({
      severity: "error",
      message: `${where} is too broad ("${text.match(hit)?.[0]}"). Claude would open this app for unrelated requests and users turn Papr off. Name the specific jobs it does.`,
    });
  }
  if (looksStuffed(text)) {
    out.push({ severity: "error", message: `${where} reads like a keyword list. Write one plain sentence about what the user is trying to do.` });
  }
  if (text.length < 25) out.push({ severity: "warning", message: `${where} is too short to route on. Say what the user is trying to get done.` });
  return out;
}

/** Content checks on top of the shape checks in parseClaudeAppConfig. */
export function lintRouting(cfg: ClaudeAppConfig): RoutingIssue[] {
  const out: RoutingIssue[] = [];
  if (!cfg.whenToUse) {
    out.push({
      severity: "warning",
      message:
        'Add metadata.claude.whenToUse, e.g. "the user wants to find leads on LinkedIn or draft outreach messages". Claude picks tools by this.',
    });
  }
  if (!cfg.examples?.length) {
    out.push({ severity: "warning", message: "Add metadata.claude.examples: 2–4 requests in the user's own words." });
  }
  out.push(...lintText("metadata.claude.whenToUse", cfg.whenToUse));
  for (const ex of cfg.examples ?? []) out.push(...lintText("metadata.claude.examples", ex).filter((i) => i.severity === "error"));
  const seen = new Set<string>();
  for (const [name, view] of Object.entries(cfg.views)) {
    out.push(...lintText(`metadata.claude.views.${name}.whenToUse`, view.whenToUse));
    for (const ex of view.examples ?? []) {
      out.push(...lintText(`metadata.claude.views.${name}.examples`, ex).filter((i) => i.severity === "error"));
      const key = ex.toLowerCase();
      if (seen.has(key)) out.push({ severity: "warning", message: `Example "${ex}" appears on more than one view; Claude can't tell them apart.` });
      seen.add(key);
    }
  }
  if (Object.keys(cfg.views).length > MAX_TOOLS_PER_APP) {
    out.push({
      severity: "warning",
      message: `Only the first ${MAX_TOOLS_PER_APP} views become Claude tools (the rest open from the card or by link). Put the most-asked-for views first.`,
    });
  }
  return out;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const sentence = (s: string): string => s.trim().replace(/[.\s]+$/, "");
/** "the user wants X" / "X" → "the user wants X". Authors write either. */
const asCondition = (s: string): string => sentence(s).replace(/^use (this )?when\s+/i, "").replace(/^when\s+/i, "");

export function quoteExamples(examples: string[] | undefined, n = 3): string {
  const list = (examples ?? []).slice(0, n).map((e) => `"${clip(sentence(e), 80)}"`);
  return list.length ? ` E.g. ${list.join(", ")}.` : "";
}

/**
 * Intent-first lead for a tool description:
 *   Papr · LinkedIn Outreach. Use when the user wants to … E.g. "…", "…".
 *
 * The app's whenToUse only goes on its primary (first) view. Copying it onto every view
 * made sibling tools identical and Claude picked "send" for "find me leads" (routing eval).
 * The app-level intent still reaches Claude through the server instructions.
 */
export function routingLead(
  appTitle: string,
  app: Pick<ClaudeApp, "cards" | "description">,
  view: ClaudeCardView,
  opts: { primary?: boolean } = { primary: true },
): string {
  const inherit = opts.primary !== false;
  const when = view.whenToUse ?? (inherit ? app.cards.whenToUse : undefined);
  const examples = view.examples?.length ? view.examples : inherit ? app.cards.examples : undefined;
  const head = `Papr · ${appTitle}.`;
  if (!when) return head;
  return `${head} Use when ${clip(asCondition(when), 280)}.${quoteExamples(examples)}`;
}

/** Server instructions: tell Claude which of the user's ongoing work lives in Papr. */
export function buildInstructions(base: string, apps: ClaudeApp[], appTitle: (a: ClaudeApp) => string): string {
  if (!apps.length) return base;
  const lines = apps.slice(0, MAX_INSTRUCTION_APPS).map((a) => {
    const about = a.cards.whenToUse ? asCondition(a.cards.whenToUse) : (a.cards.summary ?? a.description ?? "");
    return `- ${appTitle(a)}${about ? `: ${clip(sentence(about), 140)}` : ""}`;
  });
  const more = apps.length > MAX_INSTRUCTION_APPS ? `\n(+${apps.length - MAX_INSTRUCTION_APPS} more; use papr_list_apps)` : "";
  return (
    `${base}\n\nThis user already runs these in Papr. When a request matches one, use its Papr tool ` +
    `instead of doing the work from scratch:\n${lines.join("\n")}${more}`
  );
}
