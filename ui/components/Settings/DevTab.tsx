/**
 * DevTab — local-development harness. Never ships.
 *
 * Rendered only when import.meta.env.DEV is true, which Vite replaces with a
 * literal `false` in any build, so the whole subtree (and this import) is
 * dropped from the production bundle by dead-code elimination.
 *
 * Exists because the pre-auth flow is otherwise untestable in dev: the gate is
 * off (VITE_REQUIRE_PAPR_AUTH is unset), so <AuthFlow> never mounts, and you're
 * already signed in, so AuthWall would auto-advance even if it did.
 */

import { useState } from "react";
import { AuthFlow, type AuthFlowStage } from "../Auth/AuthFlow";
import { ConnectAIStep } from "../Auth/ConnectAIStep";
import type { OrgNamespaceSetupRequest } from "../Auth/OrgNamespaceSetup";
import {
  getOnboardingState,
  resetOnboarding,
  transitionTo,
  type OnboardingPhase,
} from "../../utils/onboardingState";
import { getGatewayHttpBase } from "../../utils/gatewayHttpBase";

const GATEWAY_PERF_VIEW_PATH = "/api/debug/gateway-performance/view";
const GATEWAY_PERF_JSON_PATH = "/api/debug/gateway-performance";

function gatewayPerfViewUrl(): string {
  return `${getGatewayHttpBase()}${GATEWAY_PERF_VIEW_PATH}`;
}

async function openInSystemBrowser(url: string): Promise<void> {
  if (window.electronAPI?.system?.invoke) {
    await window.electronAPI.system.invoke("shell.openExternal", url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Styles are inlined rather than kept in DevTab.css on purpose. A side-effect
 * `import "./DevTab.css"` is collected by Vite at transform time and lands in
 * the production stylesheet even when the component itself is tree-shaken —
 * verified by grepping the built CSS. Inlining keeps them inside the same
 * dead-code branch as the JSX, so nothing ships.
 */
const DEV_STYLES = `
.dev-tab__heading { margin: 28px 0 4px; font-size: 13px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--text-secondary, rgba(255,255,255,0.6)); }
.dev-tab__hint { margin: 0 0 12px; font-size: 13px; line-height: 1.5;
  color: var(--text-tertiary, rgba(255,255,255,0.5)); }
.dev-tab__hint code { padding: 1px 5px; border-radius: 4px;
  background: rgba(127,127,127,0.18); font-size: 12px; }
.dev-tab__rows { display: grid; gap: 8px; }
.dev-tab__row { display: flex; align-items: center; justify-content: space-between;
  gap: 16px; padding: 12px 14px; border-radius: 8px;
  border: 1px solid var(--border-color, rgba(127,127,127,0.25)); }
.dev-tab__row-text { display: flex; flex-direction: column; gap: 3px; }
.dev-tab__row-label { font-size: 14px; font-weight: 500; }
.dev-tab__row-note { font-size: 12px; line-height: 1.45;
  color: var(--text-tertiary, rgba(255,255,255,0.5)); }
.dev-tab__btn { flex-shrink: 0; padding: 7px 16px; border: none; border-radius: 6px;
  background: #0080ff; color: #fff; font-size: 13px; font-weight: 500; cursor: pointer; }
.dev-tab__btn:hover { background: #0070e0; }
.dev-tab__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dev-tab__chip { padding: 5px 11px; border-radius: 999px; background: transparent;
  border: 1px solid var(--border-color, rgba(127,127,127,0.3)); color: inherit;
  font-size: 12px; font-family: ui-monospace, Menlo, monospace; cursor: pointer; }
.dev-tab__chip:hover { border-color: #0080ff; }
.dev-tab__chip--on { background: #0080ff; border-color: #0080ff; color: #fff; }
.dev-tab__chip--danger { border-color: rgba(255,69,58,0.5); color: #ff453a; }
.dev-preview { position: fixed; inset: 0; z-index: 9000; display: flex;
  flex-direction: column; background: #fbfcfe; }
.dev-preview__bar { display: flex; align-items: center; gap: 12px; flex-shrink: 0;
  padding: 8px 14px; background: #ffb020; color: #1a1a1a; }
.dev-preview__badge { padding: 2px 7px; border-radius: 4px; background: rgba(0,0,0,0.75);
  color: #ffb020; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; }
.dev-preview__label { flex: 1; font-size: 13px; font-weight: 500; }
.dev-preview__exit { padding: 5px 12px; border-radius: 6px; background: transparent;
  border: 1px solid rgba(0,0,0,0.35); color: inherit; font-size: 12px;
  font-weight: 600; cursor: pointer; }
.dev-preview__exit:hover { background: rgba(0,0,0,0.12); }
.dev-preview__stage { flex: 1; position: relative; overflow: auto; }
`;

// Shape the real flow would receive from the login callback for a new user.
const FAKE_ORG_REQUEST: OrgNamespaceSetupRequest = {
  orgName: "Acme Inc",
  namespaceName: "Acme Workspace",
  needsOrg: true,
  needsNamespace: true,
};

type DevAuthPreview =
  | { kind: "flow"; stage: AuthFlowStage }
  | { kind: "claude-setup" };

const STAGES: Array<{ id: AuthFlowStage; label: string; note: string }> = [
  {
    id: "signin",
    label: "1 — Sign in",
    note: "Auto-detect is suppressed so the screen stays put. Buttons still open a real browser login.",
  },
  {
    id: "org",
    label: "2 — Org setup",
    note: "Uses placeholder org/namespace names. Submitting hits the real API — don't complete it casually.",
  },
  {
    id: "connect",
    label: "3 — Connect AI",
    note: "Real OAuth if you click a provider. Preview stays open even when you're already connected.",
  },
];

const CLAUDE_SETUP_PREVIEW: DevAuthPreview = { kind: "claude-setup" };

const PHASES: OnboardingPhase[] = [
  "welcome",
  "connect_model",
  "choose_intent",
  "first_value",
  "activated",
  "completed",
];

export function DevTab() {
  const [preview, setPreview] = useState<DevAuthPreview | null>(null);
  const [phase, setPhase] = useState(() => getOnboardingState().phase);

  const applyPhase = (next: OnboardingPhase) => {
    transitionTo(next);
    setPhase(getOnboardingState().phase);
    window.dispatchEvent(new CustomEvent("papr-onboarding-changed"));
  };

  if (preview) {
    const previewLabel =
      preview.kind === "claude-setup"
        ? "Claude guided setup (recover / stepper)"
        : `AuthFlow — starting at "${preview.stage}"`;

    return (
      <div className="dev-preview">
        <style>{DEV_STYLES}</style>
        <div className="dev-preview__bar">
          <span className="dev-preview__badge">DEV PREVIEW</span>
          <span className="dev-preview__label">{previewLabel}</span>
          <button
            type="button"
            className="dev-preview__exit"
            onClick={() => setPreview(null)}
          >
            Close preview
          </button>
        </div>
        <div className="dev-preview__stage">
          {preview.kind === "claude-setup" ? (
            <ConnectAIStep
              onDone={() => setPreview(null)}
              previewMode
              devForceClaudeRecover
            />
          ) : (
            <AuthFlow
              onComplete={() => setPreview(null)}
              devPreview={{
                initialStage: preview.stage,
                orgRequest: FAKE_ORG_REQUEST,
              }}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section dev-tab">
      <style>{DEV_STYLES}</style>
      <h2 className="settings-section__title">Developer</h2>
      <p className="settings-section__description">
        Local-only tools. This tab is compiled out of packaged builds.
      </p>

      <h3 className="dev-tab__heading">Gateway performance</h3>
      <p className="dev-tab__hint">
        Live timeline of event-loop lag, agent concurrency, background tasks, and
        recent operations. Served by the local gateway (same process as sync and
        chat).
      </p>
      <div className="dev-tab__rows">
        <div className="dev-tab__row">
          <div className="dev-tab__row-text">
            <span className="dev-tab__row-label">Performance timeline</span>
            <span className="dev-tab__row-note">
              <code>{gatewayPerfViewUrl()}</code>
            </span>
          </div>
          <button
            type="button"
            className="dev-tab__btn"
            onClick={() => void openInSystemBrowser(gatewayPerfViewUrl())}
          >
            Open in browser
          </button>
        </div>
        <div className="dev-tab__row">
          <div className="dev-tab__row-text">
            <span className="dev-tab__row-label">Raw JSON snapshot</span>
            <span className="dev-tab__row-note">
              <code>
                {getGatewayHttpBase()}
                {GATEWAY_PERF_JSON_PATH}
              </code>
            </span>
          </div>
          <button
            type="button"
            className="dev-tab__btn"
            onClick={() =>
              void openInSystemBrowser(
                `${getGatewayHttpBase()}${GATEWAY_PERF_JSON_PATH}`,
              )
            }
          >
            Open JSON
          </button>
        </div>
      </div>

      <h3 className="dev-tab__heading">Pre-auth flow</h3>
      <p className="dev-tab__hint">
        In dev the auth gate is off, so this flow never renders on its own.
        Launch a stage to inspect it in place.
      </p>
      <div className="dev-tab__rows">
        {STAGES.map((stage) => (
          <div key={stage.id} className="dev-tab__row">
            <div className="dev-tab__row-text">
              <span className="dev-tab__row-label">{stage.label}</span>
              <span className="dev-tab__row-note">{stage.note}</span>
            </div>
            <button
              type="button"
              className="dev-tab__btn"
              onClick={() => setPreview({ kind: "flow", stage: stage.id })}
            >
              Launch
            </button>
          </div>
        ))}
        <div className="dev-tab__row">
          <div className="dev-tab__row-text">
            <span className="dev-tab__row-label">4 — Claude guided setup</span>
            <span className="dev-tab__row-note">
              Opens the step-by-step &ldquo;Let&apos;s set up Claude together&rdquo;
              flow directly. Stays on screen when Claude is already connected; Run
              check / Install for me use real IPC.
            </span>
          </div>
          <button
            type="button"
            className="dev-tab__btn"
            onClick={() => setPreview(CLAUDE_SETUP_PREVIEW)}
          >
            Launch
          </button>
        </div>
      </div>

      <h3 className="dev-tab__heading">Onboarding phase</h3>
      <p className="dev-tab__hint">
        Current: <code>{phase}</code> — writes localStorage and refreshes the
        sidebar card and Home tab.
      </p>
      <div className="dev-tab__chips">
        {PHASES.map((p) => (
          <button
            key={p}
            type="button"
            className={`dev-tab__chip ${p === phase ? "dev-tab__chip--on" : ""}`}
            onClick={() => applyPhase(p)}
          >
            {p}
          </button>
        ))}
        <button
          type="button"
          className="dev-tab__chip dev-tab__chip--danger"
          onClick={() => {
            resetOnboarding();
            setPhase(getOnboardingState().phase);
            window.dispatchEvent(new CustomEvent("papr-onboarding-changed"));
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
