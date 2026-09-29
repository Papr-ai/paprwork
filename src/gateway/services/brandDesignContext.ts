/**
 * Brand context for design-time agents (architect_triage + product-architect delegation).
 *
 * The main agent gets BRAND.md injected every turn, but the product-architect sub-agent
 * does not (sub-agents get no workspace files) and the lite triage brief never mentioned
 * brand. This builds one compact block from brand.json (global + per-app override) and,
 * when nothing has been decided yet, tells the main agent to ask the user ONCE.
 *
 * "Decided" = any brand color set, OR a recorded source (e.g. the user chose Papr
 * defaults). Recording the answer in brand.json `sources` stops repeat questions.
 */

import type { BrandTokens } from "../../core/types/brand.js";

export type BrandStatus = "configured" | "partial" | "unset";

export interface BrandDesignContext {
  status: BrandStatus;
  /** Fields that are set, e.g. { primary: "#0161E0" } */
  set: Record<string, string>;
  /** Unset fields worth filling (colors, fonts, logo, voice). */
  missing: string[];
  /** Markdown block for prompts / tool results. */
  block: string;
  /** Present only when status === "unset": what the main agent must do. */
  askUser?: string;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export const BRAND_ASK_USER_INSTRUCTION =
  "BRAND UNSET — before designing UI, ask the user ONE short question in chat: " +
  "\"Do you have brand colors, fonts, or a logo I should use? (Or I'll use the clean Papr default look.)\" " +
  "Then save the answer to BOTH $PAPR_HOME/workspace/BRAND.md and brand.json (canonical schema). " +
  "If they choose defaults, write brand.json sources: [{ date, chat, note: \"User chose Papr default design\" }] so you never ask again. " +
  "Do not guess brand from a website unless the user asks. Do not block on this for non-UI work.";

export function summarizeBrand(brand: BrandTokens): BrandDesignContext {
  const set: Record<string, string> = {};
  const add = (key: string, value: unknown) => {
    if (nonEmpty(value)) set[key] = value.trim();
  };
  add("name", brand.name);
  add("primary", brand.colors?.primary);
  add("accent", brand.colors?.accent);
  add("background", brand.colors?.background);
  add("text", brand.colors?.text);
  add("headingFont", brand.fonts?.heading);
  add("bodyFont", brand.fonts?.body);
  add("logoLight", brand.logo?.light);
  add("logoDark", brand.logo?.dark);
  add("voice", brand.voice);

  const wanted = ["primary", "accent", "headingFont", "bodyFont", "logoLight", "voice"];
  const missing = wanted.filter((k) => !(k in set));
  const hasColor = "primary" in set || "accent" in set;
  const hasDecision = (brand.sources?.length ?? 0) > 0;

  const status: BrandStatus = !hasColor && !hasDecision
    ? "unset"
    : missing.length === 0
      ? "configured"
      : "partial";

  const lines = ["## User Brand (from workspace BRAND.md / brand.json)"];
  if (status === "unset") {
    lines.push("Status: UNSET — no brand chosen yet.");
    lines.push(BRAND_ASK_USER_INSTRUCTION);
  } else {
    lines.push(`Status: ${status}`);
    for (const [k, v] of Object.entries(set)) lines.push(`- ${k}: ${v}`);
    if (missing.length) {
      lines.push(`- not set (use design-system defaults, do not invent): ${missing.join(", ")}`);
    }
    lines.push(
      "Use these instead of Papr defaults: CSS vars --brand-primary, --brand-accent, --brand-font-heading, --brand-font-body " +
        "(auto-injected) or fetch('/api/brand?appId=…'). Brand colors must still pass WCAG AA in BOTH dark and light mode — " +
        "derive dark-mode surfaces from the palette rather than reusing light values.",
    );
  }

  return {
    status,
    set,
    missing,
    block: lines.join("\n"),
    ...(status === "unset" ? { askUser: BRAND_ASK_USER_INSTRUCTION } : {}),
  };
}

/** Load merged (global + optional per-app) brand and summarize. Never throws. */
export async function loadBrandDesignContext(appId?: string): Promise<BrandDesignContext | null> {
  try {
    const { getBrandService } = await import("./BrandService.js");
    const brand = await getBrandService().loadMergedBrand(appId);
    return summarizeBrand(brand);
  } catch {
    return null;
  }
}
