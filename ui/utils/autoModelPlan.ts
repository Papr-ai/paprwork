/**
 * What Auto may route to for this user: which provider, and which models on
 * that provider's ladder. Respects both the models enabled in the picker and
 * the auth the user actually has — Auto must never route to a model the user
 * turned off or cannot reach.
 */

import type { AIModel } from "../constants/models";
import type { AuthStatus } from "../hooks/useAuthStatus";
import {
  DEFAULT_AUTO_LADDERS,
  ladderModelIds,
} from "../../src/core/agents/autoLadders";

export interface AutoModelPlan {
  provider: AIModel["provider"];
  /** Ladder models that are enabled and reachable; undefined = whole ladder. */
  allowedModels?: string[];
}

type AutoProvider = "anthropic" | "openai" | "google";

/** Ladder preference order when the user can reach more than one provider. */
const PROVIDER_ORDER: readonly AutoProvider[] = ["anthropic", "openai", "google"];

function hasDirectAuth(status: AuthStatus, provider: AutoProvider): boolean {
  if (provider === "anthropic") return status.anthropic.oauth || status.anthropic.apiKey;
  if (provider === "openai") return status.openai.oauth || status.openai.apiKey;
  return status.google.apiKey;
}

/**
 * Pick the provider with the most usable ladder: the first (in ladder order)
 * where the user has direct auth AND at least one enabled model. Falls back
 * to the first provider with direct auth (whole ladder, filtered by reach),
 * then to the Papr proxy (which carries every ladder).
 */
export function resolveAutoModelPlan(input: {
  status: AuthStatus | undefined;
  /** Models pinned in the picker (Settings → Models). */
  enabledModelIds?: Iterable<string>;
  isModelAvailable?: (model: AIModel) => boolean;
  getModel?: (id: string) => AIModel | undefined;
}): AutoModelPlan {
  const { status } = input;
  if (!status) return { provider: "anthropic" };

  const enabled = input.enabledModelIds ? new Set(input.enabledModelIds) : undefined;
  const reachable = (id: string): boolean => {
    if (status.paprProxy) return true; // proxy routes every ladder model
    const model = input.getModel?.(id);
    if (!model || !input.isModelAvailable) return true;
    return input.isModelAvailable(model);
  };
  const usable = (provider: AutoProvider, requireEnabled: boolean): string[] => {
    const ladder = DEFAULT_AUTO_LADDERS[provider];
    if (!ladder) return [];
    return ladderModelIds(ladder).filter(
      (id) => reachable(id) && (!requireEnabled || !enabled || enabled.has(id)),
    );
  };

  const direct = PROVIDER_ORDER.filter((p) => hasDirectAuth(status, p));
  const candidates: AutoProvider[] = status.paprProxy
    ? [...direct, ...PROVIDER_ORDER.filter((p) => !direct.includes(p))]
    : direct;

  // 1. A provider the user can reach with models they have turned on.
  for (const provider of candidates) {
    const allowed = usable(provider, true);
    if (allowed.length > 0) return { provider, allowedModels: allowed };
  }
  // 2. Nothing enabled on any ladder — use the best reachable provider's ladder.
  for (const provider of candidates) {
    const allowed = usable(provider, false);
    if (allowed.length > 0) return { provider, allowedModels: allowed };
  }
  return { provider: candidates[0] ?? "anthropic" };
}
