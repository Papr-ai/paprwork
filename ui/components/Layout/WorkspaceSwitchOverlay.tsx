import type { ReactElement } from "react";
import {
  formatWorkspaceSwitchTarget,
  useWorkspaceSwitchOverlay,
  workspaceSwitchPhaseLabel,
  type WorkspaceSwitchOverlayPhase,
} from "../../lib/workspaceSwitchOverlay";
import "./WorkspaceSwitchOverlay.css";

const PHASES: WorkspaceSwitchOverlayPhase[] = [
  "preparing",
  "core",
  "artifacts",
  "services",
];

function phaseIndex(phase: WorkspaceSwitchOverlayPhase): number {
  return PHASES.indexOf(phase);
}

export function WorkspaceSwitchOverlay(): ReactElement | null {
  const overlay = useWorkspaceSwitchOverlay();

  if (!overlay.active) {
    return null;
  }

  const targetLabel = formatWorkspaceSwitchTarget(overlay);
  const activeIndex = Math.max(0, phaseIndex(overlay.phase));

  return (
    <div
      className="workspace-switch-overlay"
      role="dialog"
      aria-modal="true"
      aria-live="polite"
      aria-busy="true"
      aria-label="Switching workspace"
    >
      <div className="workspace-switch-overlay__panel">
        <div className="workspace-switch-overlay__spinner" aria-hidden="true" />
        <h2 className="workspace-switch-overlay__title">Switching workspace</h2>
        {targetLabel ? (
          <p className="workspace-switch-overlay__target">{targetLabel}</p>
        ) : null}
        <p className="workspace-switch-overlay__phase">
          {workspaceSwitchPhaseLabel(overlay.phase)}
        </p>
        <ol className="workspace-switch-overlay__steps" aria-hidden="true">
          {PHASES.map((phase, index) => (
            <li
              key={phase}
              className={
                index < activeIndex
                  ? "workspace-switch-overlay__step workspace-switch-overlay__step--done"
                  : index === activeIndex
                    ? "workspace-switch-overlay__step workspace-switch-overlay__step--active"
                    : "workspace-switch-overlay__step"
              }
            />
          ))}
        </ol>
      </div>
    </div>
  );
}
