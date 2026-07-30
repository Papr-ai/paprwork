/**
 * ProfileFooter - Bottom-of-sidebar identity row.
 * Avatar (→ profile section), name + plan, and a more (…) button → Settings.
 */

import React, { useEffect } from "react";
import { useProfileStore } from "../../stores/profileStore";
import { ConnectionIndicator } from "../ConnectionIndicator/ConnectionIndicator";
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

function workspaceTooltip(
  organizationName: string,
  namespaceName: string,
  workspaceName: string,
): string | undefined {
  const parts = [organizationName, namespaceName].filter(Boolean);
  if (parts.length > 0) {
    return parts.join(" · ");
  }
  return workspaceName || undefined;
}

export function ProfileFooter({ onOpenProfile, onOpenSettings }: ProfileFooterProps) {
  const {
    name,
    plan,
    imageUrl,
    organizationName,
    namespaceName,
    workspaceName,
    loadProfile,
  } = useProfileStore();
  const displayName = name || "Your account";
  const ini = initials(name);
  const tooltip = workspaceTooltip(organizationName, namespaceName, workspaceName);

  useEffect(() => {
    void loadProfile();

    const refresh = () => {
      void loadProfile({ force: true });
    };

    window.addEventListener("papr-auth-success", refresh);
    window.addEventListener("papr-logout-success", refresh);
    window.addEventListener("papr-organization-changed", refresh);
    window.addEventListener("papr-namespace-changed", refresh);
    window.electronAPI.papr.onLoginSuccess(refresh);
    window.electronAPI.papr.onLogoutSuccess(refresh);
    window.electronAPI.papr.onOrganizationChanged(refresh);
    window.electronAPI.papr.onNamespaceChanged(refresh);
    window.electronAPI.papr.onWorkspaceCacheUpdated(refresh);

    return () => {
      window.removeEventListener("papr-auth-success", refresh);
      window.removeEventListener("papr-logout-success", refresh);
      window.removeEventListener("papr-organization-changed", refresh);
      window.removeEventListener("papr-namespace-changed", refresh);
      window.electronAPI.papr.removeLoginSuccessListener(refresh);
      window.electronAPI.papr.removeLogoutSuccessListener(refresh);
      window.electronAPI.papr.removeOrganizationChangedListener(refresh);
      window.electronAPI.papr.removeNamespaceChangedListener(refresh);
      window.electronAPI.papr.removeWorkspaceCacheUpdatedListener(refresh);
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
        title={tooltip}
      >
        <span className="profile-footer__name">{displayName}</span>
        {plan ? <span className="profile-footer__plan">{plan}</span> : null}
      </button>

      <ConnectionIndicator />

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
