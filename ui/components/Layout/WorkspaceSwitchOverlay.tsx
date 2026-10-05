import { useMemo, type ReactElement } from "react";
import {
  formatWorkspaceSwitchTarget,
  useWorkspaceSwitchOverlay,
  workspaceSwitchPhaseLabel,
  type WorkspaceSwitchOverlaySnapshot,
} from "../../lib/workspaceSwitchOverlay";
import { useProfileStore } from "../../stores/profileStore";
import { OrgMark } from "../Sidebar/OrgMark";
import {
  defaultOrgSite,
  orgLogoSrc,
  useOrgLogos,
} from "../Sidebar/orgLogoStore";
import { useOrgList, type OrgEntry } from "../Sidebar/useOrgList";
import "../Sidebar/ProfileFooter.css";
import "./WorkspaceSwitchOverlay.css";

const PHASES = [
  "preparing",
  "core",
  "artifacts",
  "services",
] as const;

type Phase = (typeof PHASES)[number];

const PHASE_STEP_LABELS: Record<Phase, string> = {
  preparing: "Preparing workspace",
  core: "Agents & chats",
  artifacts: "Apps & documents",
  services: "Jobs & plans",
};

function phaseIndex(phase: Phase): number {
  return PHASES.indexOf(phase);
}

function resolveTargetOrg(
  overlay: WorkspaceSwitchOverlaySnapshot,
  orgs: OrgEntry[],
): OrgEntry | undefined {
  if (overlay.organizationId) {
    const byId = orgs.find((o) => o.id === overlay.organizationId);
    if (byId) {
      return byId;
    }
  }
  const name = overlay.organizationName?.trim();
  if (!name) {
    return undefined;
  }
  return orgs.find(
    (o) => o.name === name || o.organizationName === name,
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
  const branding = useOrgLogos((s) => s.branding);
  const email = useProfileStore((s) => s.email);
  const { orgs } = useOrgList();

  const targetOrg = useMemo(
    () => resolveTargetOrg(overlay, orgs),
    [overlay, orgs],
  );

  const orgDisplayName =
    overlay.organizationName?.trim() ||
    targetOrg?.name ||
    "Workspace";

  const logoSrc = useMemo(() => {
    const orgId = overlay.organizationId ?? targetOrg?.id;
    const site =
      (orgId ? branding[orgId]?.site : undefined) ??
      defaultOrgSite(
        [orgDisplayName, targetOrg?.organizationName],
        email,
      );
    return orgLogoSrc(orgId ? branding[orgId] : undefined, site);
  }, [
    branding,
    email,
    orgDisplayName,
    overlay.organizationId,
    targetOrg?.id,
    targetOrg?.organizationName,
  ]);

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
        <header className="workspace-switch-overlay__header">
          <OrgMark
            name={orgDisplayName}
            src={logoSrc}
            className="org-mark--lg workspace-switch-overlay__mark"
          />
          <div className="workspace-switch-overlay__heading">
            <h2 className="workspace-switch-overlay__title">Switching workspace</h2>
            {targetLabel ? (
              <p className="workspace-switch-overlay__target">{targetLabel}</p>
            ) : null}
          </div>
        </header>

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
