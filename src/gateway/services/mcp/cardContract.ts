/**
 * The "Claude" block an app author adds to metadata.json to show up in Claude:
 *
 *   "claude": {
 *     "enabled": true,
 *     "summary": "Find warm leads on LinkedIn and draft outreach",
 *     "views": {
 *       "status":  { "kind": "status", "from": "pipeline-summary" },
 *       "draft":   { "kind": "action", "action": "draft-message" },
 *       "send":    { "kind": "approval", "action": "send-messages" },
 *       "inbox":   { "entry": "cards/inbox.ts", "title": "Replies" }
 *     }
 *   }
 *
 * A view is either a default (status/action/approval, zero UI code) or a custom
 * entry under cards/ that uses the card kit. Each view becomes dist/cards/{name}.html.
 */
import type { AppBackendManifest } from "../../../core/types/appBackend.js";

export type CardViewKind = "status" | "action" | "approval";

export interface ClaudeCardView {
  kind?: CardViewKind;
  /** Custom card entry, relative to the app dir (must live under cards/). */
  entry?: string;
  /** status: the read action whose result is shown. */
  from?: string;
  /** action/approval: the action the primary button runs. status: optional primary. */
  action?: string;
  title?: string;
  description?: string;
}

export interface ClaudeAppConfig {
  enabled: boolean;
  summary?: string;
  views: Record<string, ClaudeCardView>;
}

const VIEW_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const ENTRY = /^cards\/[A-Za-z0-9_\-/]+\.(ts|tsx|js)$/;
const KINDS = new Set<CardViewKind>(["status", "action", "approval"]);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Returns null when the app hasn't opted in. Throws with an author-facing message on bad config. */
export function parseClaudeAppConfig(metadata: unknown): ClaudeAppConfig | null {
  if (!isRecord(metadata) || metadata.claude === undefined) return null;
  const raw = metadata.claude;
  if (!isRecord(raw)) throw new Error("metadata.claude must be an object");
  if (raw.enabled !== true) return null;
  const viewsRaw = raw.views ?? {};
  if (!isRecord(viewsRaw)) throw new Error("metadata.claude.views must be an object");
  const views: Record<string, ClaudeCardView> = {};
  for (const [name, v] of Object.entries(viewsRaw)) {
    const where = `metadata.claude.views.${name}`;
    if (!VIEW_NAME.test(name)) throw new Error(`${where}: name must be lowercase letters, digits and hyphens`);
    if (!isRecord(v)) throw new Error(`${where} must be an object`);
    const entry = str(v.entry);
    const kind = str(v.kind) as CardViewKind | undefined;
    if (entry && kind) throw new Error(`${where}: use either "entry" (custom card) or "kind" (default card), not both`);
    if (!entry && !kind) throw new Error(`${where}: needs "kind" (status, action, approval) or "entry" (cards/….ts)`);
    if (entry && (!ENTRY.test(entry) || entry.includes(".."))) throw new Error(`${where}.entry must be a file under cards/`);
    if (kind && !KINDS.has(kind)) throw new Error(`${where}.kind must be status, action or approval`);
    if (kind === "status" && !str(v.from)) throw new Error(`${where}: status views need "from" (a read action)`);
    if ((kind === "action" || kind === "approval") && !str(v.action)) throw new Error(`${where}: ${kind} views need "action"`);
    views[name] = {
      ...(kind ? { kind } : {}),
      ...(entry ? { entry } : {}),
      ...(str(v.from) ? { from: str(v.from) } : {}),
      ...(str(v.action) ? { action: str(v.action) } : {}),
      ...(str(v.title) ? { title: str(v.title) } : {}),
      ...(str(v.description) ? { description: str(v.description) } : {}),
    };
  }
  return { enabled: true, summary: str(raw.summary), views };
}

/** Cross-checks views against backend actions. Returns author-facing errors. */
export function checkViewsAgainstBackend(cfg: ClaudeAppConfig, manifest: AppBackendManifest | null): string[] {
  const errors: string[] = [];
  const actions = manifest?.actions ?? {};
  for (const [name, view] of Object.entries(cfg.views)) {
    for (const ref of [view.from, view.action]) {
      if (ref && !actions[ref]) errors.push(`metadata.claude.views.${name}: backend action "${ref}" not found in backend/manifest.json`);
    }
    if (view.kind === "status" && view.from && actions[view.from] && actions[view.from].effect !== "read") {
      errors.push(`metadata.claude.views.${name}: "${view.from}" must declare "effect": "read" to back a status card`);
    }
  }
  return errors;
}
