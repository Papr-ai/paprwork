/**
 * ProfileFooter - Bottom-of-rail identity: avatar (→ profile) with a hover card showing
 * name + active org/namespace, your agent (→ personalize), org logo, Edit profile and Settings.
 * The avatar wears the org's logo as a badge so you always know which workspace you are in.
 */

import { useCallback, useEffect } from "react";
import { formatActiveWorkspaceLabel } from "../../lib/workspaceSwitchOverlay";
import { useCloudMemoryStatusStore } from "../../stores/cloudMemoryStatusStore";
import { UserAvatar } from "../common/UserAvatar";
import { useProfileStore } from "../../stores/profileStore";
import { AgentGlyph } from "../Agent/AgentGlyph";
import { useAgentIdentity, useAgentName } from "../Agent/agentIdentityStore";
import { RailIcons } from "./railIcons";
import { OrgMark } from "./OrgMark";
import { OrgSection } from "./OrgSection";
import { defaultOrgSite, orgLogoSrc, useOrgLogos } from "./orgLogoStore";
import { useOrgList, type OrgEntry } from "./useOrgList";
import "./ProfileFooter.css";

interface ProfileFooterProps {
  onOpenProfile: () => void;
  onOpenSettings: () => void;
}

export function ProfileFooter({ onOpenProfile, onOpenSettings }: ProfileFooterProps) {
  const planAttention = useCloudMemoryStatusStore((state) => state.planAttention);
  const planStatus = useCloudMemoryStatusStore((state) => state.status);
  const planAttentionHint = planStatus
    ? `${planStatus.label} — open Billing in Settings`
    : "Billing needs attention — open Billing in Settings";
  const {
    name,
    imageUrl,
    organizationName,
    namespaceName,
    workspaceName,
    email,
    loadProfile,
    setProfile,
  } = useProfileStore();
  const displayName = name.trim() || "Your account";
  const agentName = useAgentName();
  const openAgentSheet = useAgentIdentity((s) => s.openSheet);
  const workspaceLabel =
    formatActiveWorkspaceLabel({
      organizationName,
      namespaceName,
      workspaceName,
    }) ?? "";
  const { orgs, activeId, switching, switchTo } = useOrgList();
  // Logo is per org. Until the org list loads, fall back to the profile's org name.
  const branding = useOrgLogos((s) => s.branding);
  const siteFor = useCallback(
    (org: OrgEntry) => branding[org.id]?.site ?? defaultOrgSite([org.name, org.organizationName], email),
    [branding, email],
  );
  const activeOrg = orgs.find((o) => o.id === activeId);
  const orgName = activeOrg?.name || organizationName || workspaceName || "";
  const orgLogo = activeOrg
    ? orgLogoSrc(branding[activeOrg.id], siteFor(activeOrg))
    : orgLogoSrc(undefined, defaultOrgSite([organizationName, workspaceName], email));
  const badge = orgName ? <OrgMark name={orgName} src={orgLogo} className="rail-account__badge" /> : null;
  useEffect(() => {
    void loadProfile();

    const refresh = () => {
      void loadProfile({ force: true });
    };

    // The workspace cache is rewritten by background Parse refreshes, and the
    // reload this triggers is what starts those refreshes. Throttling it keeps
    // the two from driving each other.
    const refreshFromCacheUpdate = () => {
      void loadProfile({ force: true, throttle: true });
    };

    const applyWorkspaceLabels = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        organizationName?: string;
        namespaceName?: string;
      };
      if (!detail?.organizationName && !detail?.namespaceName) {
        return;
      }
      setProfile({
        organizationName: detail.organizationName,
        namespaceName: detail.namespaceName,
      });
    };

    window.addEventListener("papr-auth-success", refresh);
    window.addEventListener("papr-logout-success", refresh);
    window.addEventListener("papr-organization-changed", refresh);
    window.addEventListener("papr-namespace-changed", refresh);
    window.addEventListener("papr-workspace-reload", refresh);
    window.addEventListener("papr-workspace-switch-complete", refresh);
    window.addEventListener("papr-workspace-labels-updated", applyWorkspaceLabels);
    window.electronAPI.papr.onLoginSuccess(refresh);
    window.electronAPI.papr.onLogoutSuccess(refresh);
    window.electronAPI.papr.onOrganizationChanged(refresh);
    window.electronAPI.papr.onNamespaceChanged(refresh);
    window.electronAPI.papr.onWorkspaceCacheUpdated(refreshFromCacheUpdate);

    return () => {
      window.removeEventListener("papr-auth-success", refresh);
      window.removeEventListener("papr-logout-success", refresh);
      window.removeEventListener("papr-organization-changed", refresh);
      window.removeEventListener("papr-namespace-changed", refresh);
      window.removeEventListener("papr-workspace-reload", refresh);
      window.removeEventListener("papr-workspace-switch-complete", refresh);
      window.removeEventListener("papr-workspace-labels-updated", applyWorkspaceLabels);
      window.electronAPI.papr.removeLoginSuccessListener(refresh);
      window.electronAPI.papr.removeLogoutSuccessListener(refresh);
      window.electronAPI.papr.removeOrganizationChangedListener(refresh);
      window.electronAPI.papr.removeNamespaceChangedListener(refresh);
      window.electronAPI.papr.removeWorkspaceCacheUpdatedListener(
        refreshFromCacheUpdate,
      );
    };
  }, [loadProfile, setProfile]);

  return (
    <div className="rail-item rail-item--has-peek rail-item--peek-bottom rail-account">
      <button
        type="button"
        className="rail-account__avatar"
        onClick={onOpenProfile}
        aria-label={[`Account`, orgName, planAttention ? planAttentionHint : ""].filter(Boolean).join(" — ")}
      >
        <UserAvatar imageUrl={imageUrl} displayName={name} alt={displayName} size={32} />
        {badge}
        {planAttention ? <i className="rail-btn__badge rail-btn__badge--warn" aria-hidden="true" /> : null}
      </button>

      <div className="rail-peek rail-account__card" role="menu" aria-label="Account">
        <button type="button" className="rail-account__head" onClick={onOpenProfile} title="Edit profile">
          <span className="rail-account__photo">
            <UserAvatar imageUrl={imageUrl} displayName={name} alt={displayName} size={40} />
            {badge}
          </span>
          <span>
            <b>{displayName}</b>
            {workspaceLabel ? (
              <small>{workspaceLabel}</small>
            ) : null}
          </span>
        </button>

        <h6>Your agent</h6>
        <button type="button" className="rail-account__row" onClick={openAgentSheet} data-agent-hover>
          <AgentGlyph size={24} />
          <span className="rail-account__label">{agentName}</span>
          <em>Personalize</em>
        </button>

        <OrgSection orgs={orgs} activeId={activeId} switching={switching} onSwitch={switchTo} siteFor={siteFor} />

        {planAttention ? (
          <p className="rail-account__attention" role="status">{planAttentionHint}</p>
        ) : null}

        <footer className="rail-peek__footer rail-account__footer">
          <button type="button" onClick={onOpenProfile}>
            <RailIcons.person />
            Edit profile
          </button>
          <button type="button" onClick={onOpenSettings}>
            <RailIcons.settings />
            Settings
          </button>
        </footer>
      </div>
    </div>
  );
}
