import { CHAT_MODELS } from "../constants/models";

const MODEL_NAME_BY_ID = new Map(
  CHAT_MODELS.map((model) => [model.id, model.name]),
);

/** Human-readable label for dashboard metrics (falls back to formatted id). */
export function formatModelDisplayName(modelId: string): string {
  const known = MODEL_NAME_BY_ID.get(modelId);
  if (known) return known;

  return modelId
    .split(/[-_]/)
    .map((part) => {
      if (/^gpt/i.test(part)) return part.toUpperCase();
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}
