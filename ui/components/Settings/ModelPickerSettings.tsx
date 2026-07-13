/**
 * Settings — which cloud/proxy models appear in the chat picker.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  getPickerSettingsCatalog,
  isPickerDefaultModelId,
  PICKER_DEFAULT_MODEL_IDS,
} from "../../constants/modelPicker";
import { useModelPickerSettings } from "../../hooks/useModelPickerSettings";
import "./ModelPickerSettings.css";

const LOCAL_GROUP = "Ollama (On-Device)";

interface ModelPickerSettingsProps {
  scrollIntoView?: boolean;
}

export function ModelPickerSettings({
  scrollIntoView = false,
}: ModelPickerSettingsProps): React.ReactElement {
  const sectionRef = useRef<HTMLDivElement>(null);
  const { enabledIds, loaded, saveEnabledIds, resetToDefaults } =
    useModelPickerSettings();
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    if (scrollIntoView && sectionRef.current) {
      sectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [scrollIntoView]);

  const persistIds = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      setSaving(true);
      try {
        await saveEnabledIds(ids);
        setSavedFlash(true);
        window.setTimeout(() => setSavedFlash(false), 2000);
      } finally {
        setSaving(false);
      }
    },
    [saveEnabledIds],
  );

  const toggleModel = useCallback(
    (modelId: string) => {
      const isEnabled = enabledIds.includes(modelId);
      if (isEnabled && enabledIds.length <= 1) {
        return;
      }
      const next = isEnabled
        ? enabledIds.filter((id) => id !== modelId)
        : [...enabledIds, modelId];
      void persistIds(next);
    },
    [enabledIds, persistIds],
  );

  const handleReset = async (): Promise<void> => {
    setSaving(true);
    try {
      await resetToDefaults();
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const catalog = Object.entries(getPickerSettingsCatalog()).filter(
    ([groupName]) => groupName !== LOCAL_GROUP,
  );

  return (
    <div ref={sectionRef} className="settings-section" id="picker-models">
      <div className="ai-divider">
        <span className="ai-divider__text">chat picker</span>
      </div>

      <div className="model-picker-settings-card">
        <div className="model-picker-settings-card__header">
          <div>
            <h3 className="model-picker-settings-card__title">
              Models in chat
            </h3>
            <p className="model-picker-settings-card__description">
              Toggle which models show in the chat input dropdown. On-device
              models stay under <strong>Add local</strong> in chat.
            </p>
          </div>
          <div className="model-picker-settings-card__meta">
            {loaded && (
              <span className="model-picker-settings-card__count">
                {enabledIds.length} shown
              </span>
            )}
            {saving && (
              <span className="model-picker-settings-card__status">Saving…</span>
            )}
            {!saving && savedFlash && (
              <span className="model-picker-settings-card__status model-picker-settings-card__status--saved">
                Saved
              </span>
            )}
          </div>
        </div>

        {!loaded ? (
          <p className="model-picker-settings-card__loading">Loading…</p>
        ) : (
          <div className="model-picker-settings-card__groups">
            {catalog.map(([groupName, models]) => (
              <div key={groupName} className="model-picker-settings-card__group">
                <h4 className="model-picker-settings-card__group-label">
                  {groupName}
                </h4>
                <ul className="model-picker-settings-card__list">
                  {models.map((model) => {
                    const checked = enabledIds.includes(model.id);
                    const isLastEnabled = checked && enabledIds.length === 1;
                    return (
                      <li key={model.id} className="model-picker-settings-card__row">
                        <div className="model-picker-settings-card__row-label">
                          <span className="model-picker-settings-card__name">
                            {model.name}
                          </span>
                          {isPickerDefaultModelId(model.id) && (
                            <span className="model-picker-settings-card__badge">
                              default
                            </span>
                          )}
                        </div>
                        <label
                          className="toggle-switch model-picker-settings-card__toggle"
                          title={
                            isLastEnabled
                              ? "At least one model must stay enabled"
                              : undefined
                          }
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={saving || isLastEnabled}
                            onChange={() => toggleModel(model.id)}
                          />
                          <span className="toggle-switch__slider" />
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}

        <div className="model-picker-settings-card__footer">
          <button
            type="button"
            className="model-picker-settings-card__reset"
            onClick={() => void handleReset()}
            disabled={saving || !loaded}
          >
            Reset to default list
          </button>
        </div>
      </div>
    </div>
  );
}
