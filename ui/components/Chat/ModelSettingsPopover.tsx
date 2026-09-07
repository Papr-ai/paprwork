/**
 * The four dials that decide what a turn costs, in one popover.
 *
 * Thinking, Fast, Context and Effort were all reachable only by picking a
 * different model — or not at all — so a chat ran at whatever the model
 * advertised. On a 1M-window model that is a ~636K history budget re-sent on
 * every step of a turn that can run to 100 steps.
 *
 * A row appears only when the request can actually carry it (see
 * `modelControls`): a switch wired to nothing is worse than no switch. Model
 * selection is the last row rather than the whole surface, because the model is
 * the choice you make once and the dials are the ones you revisit.
 */

import * as React from "react";
import { useState } from "react";
import type { AIModel } from "../../constants/models";
import {
  EFFORT_LABELS,
  contextOptionsForModel,
  effortLevelsForModel,
  formatContextLimit,
  modelSupportsContextChoice,
  modelSupportsEffort,
  modelSupportsFast,
  modelSupportsThinkingToggle,
  type EffortLevel,
} from "../../constants/modelControls";
import type { ChatModelSettings } from "../../utils/chatModelSettings";
import type { ResolvedModelSettings } from "../../utils/buildAgentConfig";
import { ModelPickerDropdown } from "./ModelPickerDropdown";
import "./ModelSettingsPopover.css";

type SubView = "root" | "context" | "effort" | "model";

interface ModelSettingsPopoverProps {
  model: AIModel;
  /** Effective values after dropping anything this model cannot honour. */
  resolved: ResolvedModelSettings;
  authType?: "oauth" | "apiKey";
  onChangeSettings: (patch: ChatModelSettings) => void;
  popoverRef?: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  // Model sub-view
  pickerModels: AIModel[];
  isModelAvailable?: (model: AIModel) => boolean;
  hasModel: (modelId: string) => boolean;
  hostTotalRamGb: number | null;
  onSelectModel: (model: AIModel) => void;
  onOpenSettings: () => void;
  onOpenSettingsModels: () => void;
}

function Chevron(): React.ReactElement {
  return (
    <svg
      className="model-settings-chevron"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="model-settings-row"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onChange(!checked)}
    >
      <span className="model-settings-row__label">
        {label}
        {hint && <span className="model-settings-row__hint">{hint}</span>}
      </span>
      <span
        className={`model-settings-switch ${checked ? "model-settings-switch--on" : ""}`}
      >
        <span className="model-settings-switch__knob" />
      </span>
    </button>
  );
}

function ValueRow({
  label,
  value,
  onOpen,
}: {
  label: string;
  value: string;
  onOpen: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="model-settings-row"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
    >
      <span className="model-settings-row__label">{label}</span>
      <span className="model-settings-row__value">
        {value}
        <Chevron />
      </span>
    </button>
  );
}

function OptionRow({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`model-settings-option ${selected ? "model-settings-option--selected" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
    >
      <span className="model-settings-option__label">
        {label}
        {hint && <span className="model-settings-row__hint">{hint}</span>}
      </span>
      {selected && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
        </svg>
      )}
    </button>
  );
}

function SubHeader({
  title,
  onBack,
}: {
  title: string;
  onBack: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="model-settings-back"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onBack}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path
          d="M15 6l-6 6 6 6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>{title}</span>
    </button>
  );
}

export function ModelSettingsPopover({
  model,
  resolved,
  authType,
  onChangeSettings,
  popoverRef,
  onClose,
  pickerModels,
  isModelAvailable,
  hasModel,
  hostTotalRamGb,
  onSelectModel,
  onOpenSettings,
  onOpenSettingsModels,
}: ModelSettingsPopoverProps): React.ReactElement {
  const [view, setView] = useState<SubView>("root");

  const showThinking = modelSupportsThinkingToggle(model);
  const showFast = modelSupportsFast(model, authType);
  const showContext = modelSupportsContextChoice(model);
  const showEffort = modelSupportsEffort(model) && resolved.thinking;

  const contextOptions = contextOptionsForModel(model);
  const effortLevels = effortLevelsForModel(model);

  return (
    <div ref={popoverRef} className="model-settings-popover">
      {view === "root" && (
        <>
          {showThinking && (
            <ToggleRow
              label="Thinking"
              checked={resolved.thinking}
              onChange={(next) => onChangeSettings({ thinking: next })}
            />
          )}
          {showFast && (
            <ToggleRow
              label="Fast"
              hint="2× cost"
              checked={resolved.fast}
              onChange={(next) => onChangeSettings({ fast: next })}
            />
          )}
          {showContext && (
            <ValueRow
              label="Context"
              value={formatContextLimit(resolved.contextLimit)}
              onOpen={() => setView("context")}
            />
          )}
          {showEffort && resolved.effort && (
            <ValueRow
              label="Effort"
              value={EFFORT_LABELS[resolved.effort]}
              onOpen={() => setView("effort")}
            />
          )}

          <div className="model-settings-divider" role="separator" />

          <ValueRow
            label="Model"
            value={model.name}
            onOpen={() => setView("model")}
          />
        </>
      )}

      {view === "context" && (
        <>
          <SubHeader title="Context" onBack={() => setView("root")} />
          {contextOptions.map((option) => (
            <OptionRow
              key={option}
              label={formatContextLimit(option)}
              selected={resolved.contextLimit === option}
              onSelect={() => {
                onChangeSettings({ contextLimit: option });
                setView("root");
              }}
            />
          ))}
          <p className="model-settings-note">
            Caps how much conversation is carried into each step. Everything in
            the cap is re-sent every step, so a narrower window costs less.
          </p>
        </>
      )}

      {view === "effort" && (
        <>
          <SubHeader title="Effort" onBack={() => setView("root")} />
          {effortLevels.map((level: EffortLevel) => (
            <OptionRow
              key={level}
              label={EFFORT_LABELS[level]}
              selected={resolved.effort === level}
              onSelect={() => {
                onChangeSettings({ effort: level });
                setView("root");
              }}
            />
          ))}
          <p className="model-settings-note">
            How long the model reasons before answering. Higher effort means
            more thinking tokens, which are billed as output.
          </p>
        </>
      )}

      {view === "model" && (
        <>
          <SubHeader title="Model" onBack={() => setView("root")} />
          <ModelPickerDropdown
            embedded
            currentModelId={model.id}
            pickerModels={pickerModels}
            isModelAvailable={isModelAvailable}
            hasModel={hasModel}
            hostTotalRamGb={hostTotalRamGb}
            onSelect={(next) => {
              onSelectModel(next);
              onClose();
            }}
            onOpenSettings={onOpenSettings}
            onOpenSettingsModels={onOpenSettingsModels}
          />
        </>
      )}
    </div>
  );
}
