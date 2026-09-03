/**
 * Which Anthropic models need adaptive thinking configured explicitly.
 *
 * Fable 5.1 and Sonnet 5 switch thinking on by themselves as soon as tools are
 * present, and the thinking text is withheld: the stream carries an empty
 * `thinking_delta` followed only by a `signature_delta`. The turn therefore looks
 * dead to the UI — `reasoning-start` arrives and nothing follows. Asking for
 * `display: "summarized"` is what makes the text materialise.
 *
 * Verified against the live API (same prompt, tools present):
 *   claude-opus-5     -> no thinking block
 *   claude-fable-5-1  -> thinking block, 0 chars of text, signature required
 *   claude-sonnet-5   -> thinking block, 0 chars of text, signature required
 *
 * The model list matches `requiresPiAiAdaptiveThinkingOverride` so the API-key
 * (AI SDK) and OAuth (pi-ai) paths behave identically. Opus 5 does not
 * self-enable thinking, but the pi-ai path already requests adaptive thinking for
 * it, so it stays in the set to keep the two routes from diverging.
 */
export function anthropicModelUsesAdaptiveThinking(modelId: string): boolean {
  return (
    modelId.includes("fable") ||
    modelId.includes("opus-5") ||
    modelId.includes("opus-4-8") ||
    modelId.includes("opus-4.8") ||
    modelId.includes("sonnet-5")
  );
}
