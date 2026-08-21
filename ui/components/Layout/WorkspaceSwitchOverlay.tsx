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

const PHASE_STEP_LABELS: Record<WorkspaceSwitchOverlayPhase, string> = {
  preparing: "Preparing workspace",
  core: "Agents & chats",
  artifacts: "Apps & documents",
  services: "Jobs & plans",
};

function phaseIndex(phase: WorkspaceSwitchOverlayPhase): number {
  return PHASES.indexOf(phase);
}

function WorkspaceSwitchIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3L3 8.5V15.5L12 21L21 15.5V8.5L12 3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M12 12L21 8.5M12 12V21M12 12L3 8.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StepCheckIcon(): ReactElement {
  return (
    <svg
      className="workspace-switch-overlay__step-check"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 10.5L8.5 14L15 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WorkspaceSwitchOverlay(): ReactElement | null {
  const overlay = useWorkspaceSwitchOverlay();

  if (!overlay.active) {
    return null;
  }

  const targetLabel = formatWorkspaceSwitchTarget(overlay);
  const activeIndex = Math.max(0, phaseIndex(overlay.phase));
  const activePhaseLabel = workspaceSwitchPhaseLabel(overlay.phase);

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
        <div className="workspace-switch-overlay__icon">
          <WorkspaceSwitchIcon />
        </div>
        <h2 className="workspace-switch-overlay__title">Switching workspace</h2>
        {targetLabel ? (
          <p className="workspace-switch-overlay__target">{targetLabel}</p>
        ) : null}
        <p className="workspace-switch-overlay__subtitle">{activePhaseLabel}</p>
        <ol className="workspace-switch-overlay__steps">
          {PHASES.map((phase, index) => {
            const stepClass =
              index < activeIndex
                ? "workspace-switch-overlay__step workspace-switch-overlay__step--done"
                : index === activeIndex
                  ? "workspace-switch-overlay__step workspace-switch-overlay__step--active"
                  : "workspace-switch-overlay__step";

            return (
              <li key={phase} className={stepClass}>
                <span className="workspace-switch-overlay__step-marker">
                  <StepCheckIcon />
                  <span
                    className="workspace-switch-overlay__step-spinner"
                    aria-hidden="true"
                  />
                  <span className="workspace-switch-overlay__step-dot" aria-hidden="true" />
                </span>
                <span className="workspace-switch-overlay__step-label">
                  {PHASE_STEP_LABELS[phase]}
                  {index === activeIndex ? (
                    <span className="workspace-switch-overlay__step-detail">
                      {activePhaseLabel}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
