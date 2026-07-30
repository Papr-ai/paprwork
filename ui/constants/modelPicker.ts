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

/** Map retired picker ids to their successors. */
export function migratePickerModelId(modelId: string): string {
  if (
    modelId === "gpt-5.5-low" ||
    modelId === "gpt-5.5" ||
    modelId === "gpt-5.5-high"
  ) {
    return "gpt-5-6-sol";
  }
  if (modelId === "claude-opus-4-8") {
    return "claude-opus-5";
  }
  return modelId;
}

/** Flat default list shown to new users (cloud models only). */
export const PICKER_DEFAULT_MODEL_IDS: readonly string[] = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-fable-5",
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
  "claude-opus-5",
  "gpt-5-6-sol",
  "glm-5.2-max",
  "qwen/qwen3-32b",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
];

/** Pre-Fable/Opus-5 defaults (Sonnet 5 era) — upgrade on next load. */
export const PRE_FABLE_PICKER_DEFAULT_MODEL_IDS: readonly string[] = [
  "claude-sonnet-5",
  "claude-opus-4-6",
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

/** Non-Anthropic defaults — if all missing from a short list, settings were likely clobbered. */
const CROSS_PROVIDER_DEFAULT_MARKERS: readonly string[] = [
  "gpt-5-6-sol",
  "gemini-3.5-flash",
  "glm-5.2-max",
  "qwen/qwen3-32b",
];

function healTruncatedPickerList(migrated: string[]): string[] {
  if (migrated.length >= PICKER_DEFAULT_MODEL_IDS.length) {
    return migrated;
  }
  // Single-model lists are intentional user choices, not clobber artifacts.
  if (migrated.length <= 1) {
    return migrated;
  }
  const hasCrossProviderDefault = CROSS_PROVIDER_DEFAULT_MARKERS.some((id) =>
    migrated.includes(id),
  );
  if (hasCrossProviderDefault) {
    return migrated;
  }
  const allAnthropic = migrated.every((id) => {
    const model = getModelById(id);
    return model?.provider === "anthropic";
  });
  if (!allAnthropic) {
    return migrated;
  }
  return [...new Set([...PICKER_DEFAULT_MODEL_IDS, ...migrated])];
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

  if (sameModelIdSet(migrated, PRE_FABLE_PICKER_DEFAULT_MODEL_IDS)) {
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

  return healTruncatedPickerList(migrated);
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
  const enabledSet = new Set(resolveEnabledPickerModelIds(enabledIds));
  return CHAT_MODELS.filter(
    (model) => enabledSet.has(model.id) && isChatPickerModelId(model.id),
  );
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
