/**
 * One Claude tool per published card view.
 *
 *   linkedin-outreach_status   "Show LinkedIn Outreach's pipeline in Papr…"   → status card
 *   linkedin-outreach_draft    "Open LinkedIn Outreach ready to draft…"       → form, prefilled from args
 *   linkedin-outreach_send     "Propose sending … for the user to approve"     → approval card
 *
 * Every generated tool only OPENS a card, so all are read-only for the model. Anything
 * that changes the world runs from a button in the card (papr_api, hidden from the
 * model), and `external` actions need an explicit Approve click.
 */
import { z, type ZodTypeAny } from "zod";
import type { AppBackendInputSchema } from "../../../core/types/appBackend.js";
import type { CardsManifestView } from "./cardBuild.js";
import type { ClaudeApp } from "./catalog.js";
import { MAX_TOOLS_PER_APP, routingLead } from "./routing.js";

/** ~15 apps × 3 views. Past this, apps are reachable via papr_list_apps / instructions. */
export const MAX_APP_TOOLS = 45;
const RESERVED = new Set(["papr_api", "papr_open_app", "papr_list_apps"]);

export interface AppToolSpec {
  name: string;
  title: string;
  description: string;
  app: ClaudeApp;
  view: string;
  spec: CardsManifestView;
  input?: AppBackendInputSchema;
  /** approval: all declared-required fields are required; action: everything optional (prefill). */
  requireInput: boolean;
}

const humanize = (s: string): string => s.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

export function appTitle(app: ClaudeApp): string {
  return app.name?.trim() || humanize(app.slug);
}

function toolBaseName(slug: string, view: string): string {
  const clean = (s: string, max: number): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
  return `${clean(slug, 40) || "app"}_${clean(view, 20) || "view"}`;
}

/** Intent first (routing.ts), then what the card does. */
function describe(app: ClaudeApp, view: string, spec: CardsManifestView): string {
  const title = appTitle(app);
  const primary = Object.keys(app.cards.views)[0] === view;
  const lead = routingLead(title, app, spec, { primary });
  const routed = Boolean(spec.whenToUse ?? (primary ? app.cards.whenToUse : undefined));
  const about = spec.description ?? app.cards.summary ?? app.description;
  const tail = !routed && about ? ` ${about.trim().replace(/\.?$/, ".")}` : "";
  const what = spec.actionSpec?.description ? lowerFirst(spec.actionSpec.description.replace(/\.$/, "")) : humanize(spec.action ?? view).toLowerCase();
  const mac = spec.actionSpec?.runsOn === "mac" ? " It runs on the publisher's Mac when it's awake." : "";
  switch (spec.kind) {
    case "status":
      return `${lead} Shows ${spec.title ? spec.title.toLowerCase() : "current status"} as a live card.${tail}`;
    case "action":
      return `${lead} Opens a card ready to ${what}; arguments prefill the form and the user presses the button to run it.${mac}${tail}`;
    case "approval":
      return `${lead} Proposes "${what}" on a card for review; nothing happens until the user clicks Approve.${mac}${tail}`;
    default:
      return `${lead} Opens ${spec.title ?? humanize(view)} as an interactive card.${tail}`;
  }
}

/** Deterministic: same catalog → same tool names, so Claude's tool list is stable. */
export function planAppTools(apps: ClaudeApp[], maxTools = MAX_APP_TOOLS): AppToolSpec[] {
  const used = new Set(RESERVED);
  const out: AppToolSpec[] = [];
  for (const app of apps) {
    // Author order: the most-asked-for views come first (validate_app says so).
    for (const [view, spec] of Object.entries(app.cards.views).slice(0, MAX_TOOLS_PER_APP)) {
      if (out.length >= maxTools) return out;
      const base = toolBaseName(app.slug, view);
      let name = base;
      for (let i = 2; used.has(name); i++) name = `${base.slice(0, 60)}-${i}`;
      used.add(name);
      const input = spec.kind === "action" || spec.kind === "approval" ? spec.actionSpec?.input : undefined;
      out.push({
        name,
        title: `${appTitle(app)} · ${spec.title ?? humanize(view)}`,
        description: describe(app, view, spec),
        app,
        view,
        spec,
        ...(input ? { input } : {}),
        requireInput: spec.kind === "approval",
      });
    }
  }
  return out;
}

/** Flat JSON Schema subset (see parseInputSchema) → zod raw shape for McpServer.registerTool. */
export function inputSchemaToZodShape(input: AppBackendInputSchema | undefined, requireInput: boolean): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};
  const required = new Set(requireInput ? (input?.required ?? []) : []);
  for (const [key, f] of Object.entries(input?.properties ?? {})) {
    let t: ZodTypeAny;
    if (f.enum && f.enum.length > 0) {
      const values = f.enum.map(String) as [string, ...string[]];
      t = z.enum(values);
    } else if (f.type === "boolean") t = z.boolean();
    else if (f.type === "integer") t = z.number().int();
    else if (f.type === "number") t = z.number();
    else t = f.maxLength ? z.string().max(f.maxLength) : z.string();
    const desc = [f.title, f.description].filter(Boolean).join(": ");
    if (desc) t = t.describe(desc);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}

/** Backend action params are strings. */
export function argsToParams(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}

export function toolResultFor(tool: AppToolSpec, args: Record<string, unknown>, appsBaseUrl: string) {
  const { app, view, spec } = tool;
  const title = appTitle(app);
  const data =
    spec.kind === "approval" ? { proposal: args, params: argsToParams(args) } : spec.kind === "action" ? args : {};
  const text =
    spec.kind === "approval"
      ? `Proposed in ${title}. Waiting for the user to approve on the card.`
      : spec.kind === "action"
        ? `Opened ${title} with the form filled in. The user runs it from the card.`
        : `Showing ${title} · ${spec.title ?? humanize(view)}.`;
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: {
      namespaceId: app.namespaceId,
      slug: app.slug,
      title,
      ...(app.author ? { publisher: app.author } : {}),
      openUrl: `${appsBaseUrl}/${app.namespaceId}/${app.slug}`,
      view,
      data,
    },
  };
}
