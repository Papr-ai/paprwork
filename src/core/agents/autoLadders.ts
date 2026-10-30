/**
 * Auto model ladders — pure data shared by the gateway router
 * (services/agent/jevTurnRouter.ts) and the chat UI (buildAgentConfig.ts).
 *
 * Kept free of runtime imports so the UI can read it without bundling the
 * Jev client.
 */

import type { Provider } from "../types/agents.js";

export const AUTO_CAPABILITIES = ["basic", "strong", "frontier"] as const;
export type AutoCapability = (typeof AUTO_CAPABILITIES)[number];

/**
 * Per-provider capability ladder. `models` is the preferred rung per
 * capability; `alternates` are tried in order when the preferred model is not
 * one the user has enabled and can reach. Effort is a separate axis: any rung
 * in `effortModels` gets Jev's effort pick applied; the rest run without one.
 */
export interface AutoLadder {
  models: Record<AutoCapability, string>;
  alternates?: Partial<Record<AutoCapability, readonly string[]>>;
  /** Models on this ladder (primary or alternate) that accept a reasoning effort. */
  effortModels: ReadonlySet<string>;
}

const OPENAI_LADDER: AutoLadder = {
  // Basic is Luna: it runs on ChatGPT sign-in and a Platform key alike.
  models: { basic: "gpt-5-6-luna", strong: "gpt-5.5", frontier: "gpt-5.5" },
  alternates: {
    basic: ["gpt-5-6-terra", "gpt-5-6-sol"],
    strong: ["gpt-5-6-sol", "gpt-5-6-terra", "gpt-6-astra"],
    frontier: ["gpt-6-astra", "gpt-5-6-sol"],
  },
  effortModels: new Set([
    "gpt-5.4-mini",
    "gpt-5.5",
    "gpt-5-6-luna",
    "gpt-5-6-terra",
    "gpt-5-6-sol",
    "gpt-6-astra",
  ]),
};

export const DEFAULT_AUTO_LADDERS: Partial<Record<Provider, AutoLadder>> = {
  anthropic: {
    models: {
      basic: "claude-haiku-4-5",
      strong: "claude-sonnet-5-5",
      frontier: "claude-opus-5-5",
    },
    alternates: {
      basic: ["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6"],
      strong: ["claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-5-5", "claude-opus-5"],
      frontier: ["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-sonnet-5"],
    },
    effortModels: new Set([
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-fable-5-1",
    ]),
  },
  openai: OPENAI_LADDER,
  "openai-codex": OPENAI_LADDER,
  google: {
    models: {
      basic: "gemini-3.5-flash-lite",
      strong: "gemini-3.8-flash",
      frontier: "gemini-3.1-pro-preview",
    },
    alternates: {
      basic: ["gemini-3.8-flash"],
      strong: ["gemini-3.1-pro-preview", "gemini-3.5-flash-lite"],
      frontier: ["gemini-3.8-flash"],
    },
    effortModels: new Set(),
  },
};

/** Every model a ladder could route to, primary first. */
export function ladderModelIds(ladder: AutoLadder): string[] {
  const ids = new Set<string>();
  for (const cap of AUTO_CAPABILITIES) {
    ids.add(ladder.models[cap]);
    for (const alt of ladder.alternates?.[cap] ?? []) ids.add(alt);
  }
  return [...ids];
}

/**
 * Model for a capability, restricted to `allowed` when given. Order: the
 * preferred rung, its alternates, then the other capabilities' preferred
 * rungs — rounding up before down, since an under-powered answer is the
 * visible failure. Null when nothing on the ladder is allowed.
 */
export function pickLadderModel(
  ladder: AutoLadder,
  capability: AutoCapability,
  allowed?: ReadonlySet<string>,
): string | null {
  const preferred = ladder.models[capability];
  if (!allowed) return preferred;
  const idx = AUTO_CAPABILITIES.indexOf(capability);
  const order = [
    ...AUTO_CAPABILITIES.slice(idx + 1),
    ...AUTO_CAPABILITIES.slice(0, idx).reverse(),
  ];
  const candidates = [
    preferred,
    ...(ladder.alternates?.[capability] ?? []),
    ...order.flatMap((c) => [ladder.models[c], ...(ladder.alternates?.[c] ?? [])]),
  ];
  return candidates.find((m) => allowed.has(m)) ?? null;
}
