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
  "claude-sonnet-5",
  "claude-opus-4-6",
  "gpt-5-6-sol",
  "glm-5.2-max",
  "qwen/qwen3-32b",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
];

/** Pre-Sonnet-5 curated defaults — used to upgrade saved picker preferences. */
export const LEGACY_PICKER_DEFAULT_MODEL_IDS: readonly string[] = [
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

function sameModelIdSet(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((id) => setA.has(id));
}

/** Upgrade saved picker lists after Sonnet 5 launch. */
export function migrateEnabledPickerModelIds(
  enabledIds: string[] | null | undefined,
): string[] {
  if (!enabledIds || enabledIds.length === 0) {
    return [...PICKER_DEFAULT_MODEL_IDS];
  }

  const migrated = [
    ...new Set(
      enabledIds.map(migratePickerModelId).filter(isChatPickerModelId),
    ),
  ];

  if (migrated.length === 0) {
    return [...PICKER_DEFAULT_MODEL_IDS];
  }

  if (sameModelIdSet(migrated, LEGACY_PICKER_DEFAULT_MODEL_IDS)) {
    return [...PICKER_DEFAULT_MODEL_IDS];
  }

  // Swap the default Sonnet slot when users still have 4.6 enabled without 5.
  if (
    migrated.includes("claude-sonnet-4-6") &&
    !migrated.includes("claude-sonnet-5")
  ) {
    return migrated.map((id) =>
      id === "claude-sonnet-4-6" ? "claude-sonnet-5" : id,
    );
  }

  return migrated;
}

export function isPickerDefaultModelId(modelId: string): boolean {
  return PICKER_DEFAULT_MODEL_IDS.includes(modelId);
}

/** User override from Settings; null/empty → curated defaults. */
export function resolveEnabledPickerModelIds(
  enabledIds: string[] | null | undefined,
): string[] {
  return migrateEnabledPickerModelIds(enabledIds);
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
