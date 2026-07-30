/**
 * Loads and persists which models appear in the chat picker.
 */

import { useCallback, useEffect, useState } from "react";
import { gateway } from "../src/lib/gateway";
import {
  PICKER_DEFAULT_MODEL_IDS,
  getPickerModels,
  migrateEnabledPickerModelIds,
  migratePickerModelId,
  isChatPickerModelId,
} from "../constants/modelPicker";

interface UiPreferencesPayload {
  enabledPickerModelIds?: string[] | null;
}

export function useModelPickerSettings(): {
  enabledIds: string[];
  pickerModels: ReturnType<typeof getPickerModels>;
  loaded: boolean;
  saveEnabledIds: (ids: string[]) => Promise<void>;
  resetToDefaults: () => Promise<void>;
  reload: () => Promise<void>;
} {
  const [enabledIds, setEnabledIds] = useState<string[]>([
    ...PICKER_DEFAULT_MODEL_IDS,
  ]);
  const [loaded, setLoaded] = useState(false);

  const applyFromSettings = useCallback((raw: string[] | null | undefined) => {
    setEnabledIds(migrateEnabledPickerModelIds(raw));
  }, []);

  const reload = useCallback(async () => {
    try {
      const response = await gateway.send("settings:get");
      if (response.success && response.data) {
        const prefs = (response.data as { uiPreferences?: UiPreferencesPayload })
          .uiPreferences;
        const raw = prefs?.enabledPickerModelIds;
        const migrated = migrateEnabledPickerModelIds(raw);
        setEnabledIds(migrated);

        if (raw && raw.length > 0) {
          const normalizedRaw = [
            ...new Set(
              raw.map(migratePickerModelId).filter(isChatPickerModelId),
            ),
          ];
          const needsPersist =
            JSON.stringify(normalizedRaw) !== JSON.stringify(migrated);
          if (needsPersist) {
            await gateway.send("settings:save-ui-preferences", {
              enabledPickerModelIds: migrated,
            });
          }
        }
      }
    } catch {
      applyFromSettings(null);
    } finally {
      setLoaded(true);
    }
  }, [applyFromSettings]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ enabledPickerModelIds?: string[] }>)
        .detail;
      if (detail?.enabledPickerModelIds) {
        applyFromSettings(detail.enabledPickerModelIds);
      } else {
        void reload();
      }
    };
    window.addEventListener("papr:picker-models-updated", onUpdated);
    return () => {
      window.removeEventListener("papr:picker-models-updated", onUpdated);
    };
  }, [applyFromSettings, reload]);

  const saveEnabledIds = useCallback(async (ids: string[]) => {
    const normalized = migrateEnabledPickerModelIds(ids);
    const response = await gateway.send("settings:save-ui-preferences", {
      enabledPickerModelIds: normalized,
    });
    if (!response.success) {
      throw new Error(response.error ?? "Failed to save model picker settings");
    }
    setEnabledIds(normalized);
    window.dispatchEvent(
      new CustomEvent("papr:picker-models-updated", {
        detail: { enabledPickerModelIds: normalized },
      }),
    );
  }, []);

  const resetToDefaults = useCallback(async () => {
    await saveEnabledIds([...PICKER_DEFAULT_MODEL_IDS]);
  }, [saveEnabledIds]);

  return {
    enabledIds,
    pickerModels: getPickerModels(enabledIds),
    loaded,
    saveEnabledIds,
    resetToDefaults,
    reload,
  };
}
