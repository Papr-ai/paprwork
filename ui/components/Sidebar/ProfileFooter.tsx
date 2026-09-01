/**
 * ProfileFooter - Bottom-of-sidebar identity row.
 * Avatar (→ profile), user name + active org/namespace, and a more (…) button → Settings.
 */

import React, { useEffect } from "react";
import { formatActiveWorkspaceLabel } from "../../lib/workspaceSwitchOverlay";
import { useProfileStore } from "../../stores/profileStore";
import "./ProfileFooter.css";

interface ProfileFooterProps {
  onOpenProfile: () => void;
  onOpenSettings: () => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

export function ProfileFooter({ onOpenProfile, onOpenSettings }: ProfileFooterProps) {
  const {
    name,
    imageUrl,
    organizationName,
    namespaceName,
    workspaceName,
    loadProfile,
  } = useProfileStore();
  const displayName = name.trim() || "Your account";
  const workspaceLabel =
    formatActiveWorkspaceLabel({
      organizationName,
      namespaceName,
      workspaceName,
    }) ?? "";
  const ini = initials(name);

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

    window.addEventListener("papr-auth-success", refresh);
    window.addEventListener("papr-logout-success", refresh);
    window.addEventListener("papr-organization-changed", refresh);
    window.addEventListener("papr-namespace-changed", refresh);
    window.addEventListener("papr-workspace-reload", refresh);
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
      window.electronAPI.papr.removeLoginSuccessListener(refresh);
      window.electronAPI.papr.removeLogoutSuccessListener(refresh);
      window.electronAPI.papr.removeOrganizationChangedListener(refresh);
      window.electronAPI.papr.removeNamespaceChangedListener(refresh);
      window.electronAPI.papr.removeWorkspaceCacheUpdatedListener(
        refreshFromCacheUpdate,
      );
    };
  }, [loadProfile]);

  return (
    <div className="profile-footer">
      <button
        className="profile-footer__avatar"
        onClick={onOpenProfile}
        aria-label="Edit profile"
        title="Edit profile"
      >
        {imageUrl ? (
          <img src={imageUrl} alt={displayName} />
        ) : ini ? (
          <span className="profile-footer__initials">{ini}</span>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>

      <button
        className="profile-footer__id"
        onClick={onOpenProfile}
        title={workspaceLabel || undefined}
      >
        <span className="profile-footer__name">{displayName}</span>
        {workspaceLabel ? (
          <span className="profile-footer__plan">{workspaceLabel}</span>
        ) : null}
      </button>

      <button
        className="profile-footer__more"
        onClick={onOpenSettings}
        aria-label="Settings"
        title="Settings"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
    </div>
  );
}
