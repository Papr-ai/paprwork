/**
 * The composer's model pill and the settings popover it opens.
 *
 * Split out of `InputBar` to keep the composer's own concerns readable. Open
 * state stays *there* rather than here: the composer has a second popover
 * (context pills) and only one of the two may be open at a time, so the choice
 * of which is open belongs to whoever knows about both.
 */

import * as React from "react";
import { useRef } from "react";
import type { AIModel } from "../../constants/models";
import type { ChatModelSettings } from "../../utils/chatModelSettings";
import type { ResolvedModelSettings } from "../../utils/buildAgentConfig";
import { ModelSettingsPopover } from "./ModelSettingsPopover";
import { useDismissOnOutsideClick } from "../../hooks/useDismissOnOutsideClick";

interface ModelSettingsButtonProps {
  model: AIModel;
  resolved: ResolvedModelSettings;
  authType?: "oauth" | "apiKey";
  onChangeSettings: (patch: ChatModelSettings) => void;
  pickerModels: AIModel[];
  isModelAvailable?: (model: AIModel) => boolean;
  hasModel: (modelId: string) => boolean;
  hostTotalRamGb: number | null;
  onSelectModel: (model: AIModel) => void;
  onOpenSettings: () => void;
  onOpenSettingsModels: () => void;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Return focus to the composer once the popover is dismissed. */
  onDismissed: () => void;
}

export function ModelSettingsButton({
  model,
  resolved,
  authType,
  onChangeSettings,
  pickerModels,
  isModelAvailable,
  hasModel,
  hostTotalRamGb,
  onSelectModel,
  onOpenSettings,
  onOpenSettingsModels,
  open,
  onOpenChange,
  onDismissed,
}: ModelSettingsButtonProps): React.ReactElement {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useDismissOnOutsideClick(
    open,
    () => onOpenChange(false),
    buttonRef,
    popoverRef,
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="model-selector-pill"
        title="Model and reasoning settings"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onOpenChange(!open)}
      >
        <span>{model.name}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <ModelSettingsPopover
          popoverRef={popoverRef}
          model={model}
          resolved={resolved}
          authType={authType}
          onChangeSettings={onChangeSettings}
          onClose={() => {
            onOpenChange(false);
            onDismissed();
          }}
          pickerModels={pickerModels}
          isModelAvailable={isModelAvailable}
          hasModel={hasModel}
          hostTotalRamGb={hostTotalRamGb}
          onSelectModel={onSelectModel}
          onOpenSettings={() => {
            onOpenSettings();
            onOpenChange(false);
          }}
          onOpenSettingsModels={() => {
            onOpenSettingsModels();
            onOpenChange(false);
          }}
        />
      )}
    </>
  );
}
