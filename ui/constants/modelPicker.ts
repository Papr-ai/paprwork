/**
 * Chat model picker — curated defaults + user-enabled models from Settings.
 */

import {
  CHAT_MODELS,
  getModelById,
  getModelGroups,
  type AIModel,
} from "./models";

/** Models kept for jobs/runtime but hidden from chat picker. */
export const CHAT_PICKER_EXCLUDED_MODEL_IDS: readonly string[] = [
  "composer-2.5",
  "gpt-5.5-low",
  "gpt-5.5",
  "gpt-5.5-high",
];

export function isChatPickerModelId(modelId: string): boolean {
  return (
    !CHAT_PICKER_EXCLUDED_MODEL_IDS.includes(modelId) &&
    getModelById(modelId) !== undefined
  );
}

/** Map retired picker ids to their GPT-5.6 successors. */
export function migratePickerModelId(modelId: string): string {
  if (
    modelId === "gpt-5.5-low" ||
    modelId === "gpt-5.5" ||
    modelId === "gpt-5.5-high"
  ) {
    return "gpt-5-6-sol";
  }
  return modelId;
}

/** Flat default list shown to new users (cloud models only). */
export const PICKER_DEFAULT_MODEL_IDS: readonly string[] = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-8",
  "gpt-5-6-sol",
  "glm-5.2-max",
  "qwen/qwen3-32b",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
];

export function isPickerDefaultModelId(modelId: string): boolean {
  return PICKER_DEFAULT_MODEL_IDS.includes(modelId);
}

/** User override from Settings; null/empty → curated defaults. */
export function resolveEnabledPickerModelIds(
  enabledIds: string[] | null | undefined,
): string[] {
  const source =
    enabledIds && enabledIds.length > 0
      ? [
          ...new Set(
            enabledIds.map(migratePickerModelId).filter(isChatPickerModelId),
          ),
        ]
      : [...PICKER_DEFAULT_MODEL_IDS];
  return source.length > 0 ? source : [...PICKER_DEFAULT_MODEL_IDS];
}

/** Models pinned to the main chat picker (cloud + any enabled Ollama). */
export function getPickerModels(
  enabledIds: string[] | null | undefined,
): AIModel[] {
  return resolveEnabledPickerModelIds(enabledIds)
    .map((id) => getModelById(id))
    .filter((model): model is AIModel => model !== undefined);
}

/** Full catalog grouped by provider — for Settings toggles. */
export function getPickerSettingsCatalog(): Record<string, AIModel[]> {
  const groups = getModelGroups();
  const filtered: Record<string, AIModel[]> = {};
  for (const [group, models] of Object.entries(groups)) {
    const visible = models.filter((model) => isChatPickerModelId(model.id));
    if (visible.length > 0) {
      filtered[group] = visible;
    }
  }
  return filtered;
}

export function getAllPickerToggleModelIds(): string[] {
  return CHAT_MODELS.map((model) => model.id).filter(isChatPickerModelId);
}
