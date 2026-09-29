import { useEffect, type ReactElement } from "react";
import { AgentGlyph } from "../Agent/AgentGlyph";
import {
  CLOUD_APP_INSTALL_PHASES,
  useCloudAppInstallOverlayStore,
  type CloudAppInstallPhase,
} from "../../stores/cloudAppInstallOverlayStore";
import "./CloudAppInstallOverlay.css";

const PHASE_STEP_LABELS: Record<CloudAppInstallPhase, string> = {
  prepare: "Cloud",
  source: "Code",
  resources: "Jobs",
  databases: "Data",
  finalize: "Done",
};

function phaseIndex(phase: CloudAppInstallPhase): number {
  return CLOUD_APP_INSTALL_PHASES.indexOf(phase);
}

export function CloudAppInstallOverlay(): ReactElement | null {
  const active = useCloudAppInstallOverlayStore((s) => s.active);
  const appName = useCloudAppInstallOverlayStore((s) => s.appName);
  const startedAt = useCloudAppInstallOverlayStore((s) => s.startedAt);
  const phase = useCloudAppInstallOverlayStore((s) => s.phase);
  const tickPhase = useCloudAppInstallOverlayStore((s) => s.tickPhase);

  useEffect(() => {
    if (!active || startedAt === null) return;

    const interval = window.setInterval(() => {
      tickPhase(Date.now() - startedAt);
    }, 800);

    tickPhase(Date.now() - startedAt);

    return () => window.clearInterval(interval);
  }, [active, startedAt, tickPhase]);

  if (!active) {
    return null;
  }

  const activeIndex = Math.max(0, phaseIndex(phase));

  return (
    <div
      className="cloud-app-install-overlay"
      role="dialog"
      aria-modal="true"
      aria-live="polite"
      aria-busy="true"
      aria-label="Installing app"
    >
      <div className="cloud-app-install-overlay__panel">
        <div className="cloud-app-install-overlay__head">
          <AgentGlyph size={40} state="working" />
          <div className="cloud-app-install-overlay__head-text">
            <h2 className="cloud-app-install-overlay__title">Installing</h2>
            {appName ? (
              <p className="cloud-app-install-overlay__name">{appName}</p>
            ) : null}
          </div>
        </div>

        <div
          className="cloud-app-install-overlay__track"
          aria-label="Install progress"
        >
          {CLOUD_APP_INSTALL_PHASES.map((stepPhase, index) => {
            const state =
              index < activeIndex
                ? "done"
                : index === activeIndex
                  ? "active"
                  : "pending";
            return (
              <div
                key={stepPhase}
                className={`cloud-app-install-overlay__pill cloud-app-install-overlay__pill--${state}`}
              >
                <span className="cloud-app-install-overlay__pill-dot" />
                <span className="cloud-app-install-overlay__pill-label">
                  {PHASE_STEP_LABELS[stepPhase]}
                </span>
              </div>
            );
          })}
        </div>

        <p className="cloud-app-install-overlay__status">
          This can take a couple of minutes.
        </p>
      </div>
    </div>
  );
}
