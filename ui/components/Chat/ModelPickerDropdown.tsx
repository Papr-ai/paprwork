/**
 * Simplified chat model picker — flat curated list, local models, settings link.
 */

import * as React from "react";
import { useState } from "react";
import {
  CHAT_MODELS,
  ollamaModelFitsHostRam,
  getRecommendedQwenModel,
  type AIModel,
} from "../../constants/models";

interface ModelPickerDropdownProps {
  currentModelId: string;
  pickerModels: AIModel[];
  isModelAvailable?: (model: AIModel) => boolean;
  hasModel: (modelId: string) => boolean;
  hostTotalRamGb: number | null;
  onSelect: (model: AIModel) => void;
  onOpenSettings: () => void;
  onOpenSettingsModels: () => void;
}

function ModelPickerRow({
  model,
  selected,
  available,
  needsInstall,
  ramTight,
  compact,
  onSelect,
}: {
  model: AIModel;
  selected: boolean;
  available: boolean;
  needsInstall: boolean;
  ramTight: boolean;
  compact?: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`model-picker-item ${selected ? "model-picker-item--selected" : ""} ${!available ? "model-picker-item--locked" : ""} ${needsInstall ? "model-picker-item--needs-install" : ""} ${compact ? "model-picker-item--compact" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
      title={
        !available
          ? model.id === "gpt-5.3-codex"
            ? "Requires OpenAI API key — not available via ChatGPT OAuth"
            : "Add API key or connect OAuth in Settings"
          : ramTight
            ? "May need more RAM than this device"
            : needsInstall
              ? "Click to download and install"
              : undefined
      }
    >
      <div className="model-picker-item-content">
        <div className="model-picker-item-name">
          {model.name}
          {!available && (
            <span className="model-badge-locked" title="Add API key or connect OAuth">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </span>
          )}
          {ramTight && available && (
            <span className="model-badge-ram-warn" title="May need more RAM">
              RAM
            </span>
          )}
          {needsInstall && available && (
            <span className="model-badge-install" title="Download required">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
            </span>
          )}
          {model.supportsThinking && available && (
            <span className="model-badge-thinking">thinking</span>
          )}
        </div>
        {!compact && (
          <div className="model-picker-item-desc">{model.description}</div>
        )}
      </div>
      {selected && available && (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
        </svg>
      )}
    </button>
  );
}

export function ModelPickerDropdown({
  currentModelId,
  pickerModels,
  isModelAvailable,
  hasModel,
  hostTotalRamGb,
  onSelect,
  onOpenSettings,
  onOpenSettingsModels,
}: ModelPickerDropdownProps): React.ReactElement {
  const [showLocal, setShowLocal] = useState(false);

  const ollamaModels = CHAT_MODELS.filter((model) => model.provider === "ollama");
  const recommendedLocalId =
    hostTotalRamGb !== null
      ? getRecommendedQwenModel(hostTotalRamGb)
      : "qwen3.5:9b-q4_k_m";
  const recommendedLocal = ollamaModels.find(
    (model) => model.id === recommendedLocalId,
  );
  const otherLocalModels = ollamaModels.filter(
    (model) => model.id !== recommendedLocalId,
  );

  const handleSelect = (model: AIModel): void => {
    const available = isModelAvailable?.(model) ?? true;
    if (available) {
      onSelect(model);
    } else {
      onOpenSettings();
    }
  };

  const renderModel = (model: AIModel, compact = true): React.ReactElement => {
    const available = isModelAvailable?.(model) ?? true;
    const isOllama = model.provider === "ollama";
    const needsInstall = isOllama && !hasModel(model.id);
    const ramTight =
      isOllama &&
      hostTotalRamGb !== null &&
      !ollamaModelFitsHostRam(model.id, hostTotalRamGb);

    return (
      <ModelPickerRow
        key={model.id}
        model={model}
        selected={currentModelId === model.id}
        available={available}
        needsInstall={needsInstall}
        ramTight={ramTight}
        compact={compact}
        onSelect={() => handleSelect(model)}
      />
    );
  };

  return (
    <div className="model-picker-dropdown model-picker-dropdown--simple">
      {pickerModels.map((model) => renderModel(model, true))}

      <div className="model-picker-divider" role="separator" />

      <button
        type="button"
        className="model-picker-action"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShowLocal((open) => !open)}
      >
        <span>Add local</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          className={`model-picker-action-chevron ${showLocal ? "model-picker-action-chevron--open" : ""}`}
        >
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {showLocal && (
        <div className="model-picker-submenu">
          {recommendedLocal && (
            <>
              <div className="model-picker-group-label">Recommended</div>
              {renderModel(recommendedLocal, false)}
            </>
          )}
          <div className="model-picker-group-label">All local models</div>
          {otherLocalModels.map((model) => renderModel(model, false))}
        </div>
      )}

      <button
        type="button"
        className="model-picker-action"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onOpenSettingsModels}
      >
        <span>Add more…</span>
      </button>
    </div>
  );
}
