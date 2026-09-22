/**
 * Which OpenAI models accept a reasoning effort above `xhigh`.
 *
 * GPT-6 Astra is the first, and until it shipped `max` was a Z.ai/Moonshot
 * word that `toOpenAIReasoningEffort` folded down to `xhigh` on its way out —
 * correct then, silently one level short now.
 *
 * This module deliberately has no imports. The renderer decides which effort
 * rows to show and the gateway decides what to put in the request, and those
 * two answers must be the same one: a `max` row the request downgrades to
 * `xhigh` is a control wired to the wrong value, which reads as the model
 * ignoring the user. The renderer cannot import `modelNormalizer.ts` — its
 * relative imports carry `.js` specifiers Vite will not resolve back to `.ts`
 * — so the shared fact lives here instead, in the same
 * importable-from-either-side shape as `anthropicAdaptiveThinking.ts`.
 */
export function openAIModelAcceptsMaxEffort(modelId: string): boolean {
  return modelId.includes("astra");
}
