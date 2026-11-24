/**
 * Premium models on Papr's AI proxy.
 *
 * Mirrors the memory server's line (config/credits.yaml premium_input_usd_per_1m:
 * 1.50): a model whose input price is at or above $1.50 per 1M tokens needs a
 * paid plan with pay as you go when it runs on Papr credits. The server is the
 * source of truth (it returns 402 premium_requires_payg); this list only lets
 * Auto and the chat skip those models up front instead of hitting the 402.
 *
 * Only applies to Papr-proxy turns. The user's own OAuth or API key is never gated.
 */

/** Matched by prefix after normalising dots/dashes (gpt-5.6-sol == gpt-5-6-sol). */
const PREMIUM_PREFIXES: readonly string[] = [
  // Anthropic: everything except Haiku ($1.00)
  "claude-sonnet",
  "claude-opus",
  "claude-fable",
  "claude-mythos",
  // OpenAI: Sol / Terra / 5.5 / Codex / Astra (Luna and mini stay open)
  "gpt-5-6-sol",
  "gpt-5-6-terra",
  "gpt-5-5",
  "gpt-5-3-codex",
  "gpt-6-astra",
  "gpt-6-1-sol",
  // Google: Pro, 3.5 Flash ($1.50), every Gemini 4 (Hydrogen $1.50 and up). Flash 2.5-3.8 and Flash-Lite stay open
  "gemini-3-1-pro",
  "gemini-3-pro",
  "gemini-2-5-pro",
  "gemini-4-",
  // Moonshot frontier
  "kimi-k3",
];

/** gemini-3.5-flash is premium but gemini-3.5-flash-lite is not. */
const EXACT_PREMIUM = new Set(["gemini-3-5-flash"]);

function norm(id: string): string {
  return id.trim().toLowerCase().replace(/^models\//, "").replace(/\./g, "-");
}

export function isPremiumProxyModel(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  const id = norm(modelId);
  if (EXACT_PREMIUM.has(id)) return true;
  return PREMIUM_PREFIXES.some((p) => id.startsWith(p));
}

/** Best open model per provider when a premium one is not allowed. */
export const OPEN_PROXY_FALLBACK: Record<string, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5-6-luna",
  "openai-codex": "gpt-5-6-luna",
  google: "gemini-3.8-flash",
  zai: "glm-5.2",
};

export const PREMIUM_REQUIRES_PAYG_CODE = "premium_requires_payg";

export function premiumRequiresPaygMessage(modelLabel: string): string {
  return (
    `${modelLabel} on Papr credits needs a paid plan with pay as you go turned on. ` +
    "Turn it on in Settings → Billing, connect your own account for this provider, " +
    "or pick Auto or a lighter model."
  );
}
