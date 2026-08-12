/**
 * SettingsView - Settings page with tabs for API Keys, Profile, and Permissions
 * Reference: Paprwork v1 settings modal
 */

import React, { useState, useEffect, useRef } from "react";
import { useProfileStore } from "../../stores/profileStore";
import { useAppUpdater } from "../../hooks/useAppUpdater";
import { gateway } from "../../src/lib/gateway";
import { trackEvent } from "../../lib/telemetry";
import type { SettingsTab } from "../../types/settings";
import { AIModelsTab } from "./AIModelsTab";
import { IntegrationKeysTab } from "./IntegrationKeysTab";
import { CloudSyncTab } from "./CloudSyncTab";
import { DatabasesTab } from "./DatabasesTab";
import { WorkspaceMigrationTab } from "./WorkspaceMigrationTab";
import { PaprLoginSection } from "./PaprLoginSection";
import { resizeProfilePhoto } from "../../utils/profilePhoto";
import {
  persistProfileFields,
  resolveDisplayProfileImage,
  syncProfileImageToCloud,
} from "../../utils/profileImageSync";
import { useChat } from "../../hooks/useChat";
import { useTabs } from "../../hooks/useTabs";
import { startPlatformFeedbackChat } from "../../utils/startPlatformFeedbackChat";
import "./SettingsView.css";

type SettingsNavItem = {
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
};

const SETTINGS_NAV: SettingsNavItem[] = [
  {
    id: "profile",
    label: "Profile",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    id: "models",
    label: "AI Models",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v6m0 6v6M5.64 5.64l4.24 4.24m4.24 4.24l4.24 4.24M1 12h6m6 0h6M5.64 18.36l4.24-4.24m4.24-4.24l4.24-4.24" />
      </svg>
    ),
  },
  {
    id: "keys",
    label: "Key Vault",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
      </svg>
    ),
  },
  {
    id: "cloud",
    label: "Cloud Sync",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
      </svg>
    ),
  },
  {
    id: "databases",
    label: "Databases",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
      </svg>
    ),
  },
  {
    id: "migration",
    label: "Migration",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 3v12" />
        <path d="m8 11 4 4 4-4" />
        <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
      </svg>
    ),
  },
  {
    id: "permissions",
    label: "Permissions",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
  {
    id: "privacy",
    label: "Privacy",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
    ),
  },
  {
    id: "about",
    label: "About",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    ),
  },
];

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("profile");
  const [scrollToPickerModels, setScrollToPickerModels] = useState(false);

  useEffect(() => {
    trackEvent("paprwork_settings_opened", { section: "profile" } as Record<string, unknown>);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tab?: SettingsTab; section?: string }>)
        .detail;
      if (detail?.tab) {
        setActiveTab(detail.tab);
      }
      if (detail?.section === "picker-models") {
        setScrollToPickerModels(true);
      }
    };
    window.addEventListener("papr:open-settings", handler);
    return () => window.removeEventListener("papr:open-settings", handler);
  }, []);

  const handleNavClick = (tab: SettingsTab) => {
    setActiveTab(tab);
    if (tab !== "models") {
      setScrollToPickerModels(false);
    }
  };

  return (
    <div className="settings-view">
      <aside className="settings-view__sidebar">
        <div className="settings-view__sidebar-header">
          <h1 className="settings-view__title">Settings</h1>
        </div>
        <nav className="settings-view__nav" aria-label="Settings sections">
          {SETTINGS_NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-tab ${activeTab === item.id ? "settings-tab--active" : ""}`}
              onClick={() => handleNavClick(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="settings-view__main">
        <div className="settings-view__content">
          {activeTab === "models" && (
            <AIModelsTab scrollToPickerModels={scrollToPickerModels} />
          )}
          {activeTab === "keys" && <IntegrationKeysTab />}
          {activeTab === "cloud" && <CloudSyncTab />}
          {activeTab === "databases" && <DatabasesTab />}
          {activeTab === "migration" && <WorkspaceMigrationTab />}
          {activeTab === "profile" && <ProfileTab />}
          {activeTab === "permissions" && <PermissionsTab />}
          {activeTab === "privacy" && <PrivacyTab />}
          {activeTab === "about" && <AboutTab />}
        </div>
      </div>
    </div>
  );
}

function ProfileTab() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [paprProfile, setPaprProfile] = useState<{
    userId: string;
    email: string;
    displayName?: string;
    profileImage?: string;
    authenticatedAt: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const profileStore = useProfileStore();

  // Load profile on mount
  useEffect(() => {
    (async () => {
      try {
        const response = await gateway.send("settings:get");
        const data = response.data as {
          profile?: {
            name?: string;
            email?: string;
            imageUrl?: string;
            profileImageSyncPending?: boolean;
          };
        };

        const loginStatus = await window.electronAPI.papr.checkLoginStatus();
        let paprResponse = await window.electronAPI.papr.getProfile();
        if (loginStatus.success && loginStatus.isLoggedIn) {
          const refreshResult = await window.electronAPI.papr.refreshProfile();
          if (refreshResult.success && refreshResult.profile) {
            paprResponse = refreshResult;
          }
        }

        const localImageUrl = data?.profile?.imageUrl ?? "";
        const profileImageSyncPending =
          data?.profile?.profileImageSyncPending === true;

        if (paprResponse.success && paprResponse.profile) {
          setPaprProfile(paprResponse.profile);

          const resolvedImage = resolveDisplayProfileImage(
            localImageUrl,
            paprResponse.profile.profileImage ?? "",
            profileImageSyncPending,
          );

          if (data?.profile) {
            setName(data.profile.name ?? paprResponse.profile.displayName ?? "");
            setEmail(data.profile.email ?? paprResponse.profile.email ?? "");
            setImageUrl(resolvedImage);
          } else {
            setName(paprResponse.profile.displayName ?? "");
            setEmail(paprResponse.profile.email ?? "");
            setImageUrl(resolvedImage);
          }
        } else if (data?.profile) {
          // No Papr profile - use manual profile only
          setName(data.profile.name ?? "");
          setEmail(data.profile.email ?? "");
          setImageUrl(data.profile.imageUrl ?? "");
        }

        setLoaded(true);
      } catch (err) {
        console.error("[ProfileTab] Load error:", err);
        setLoaded(true);
      }
    })();

    // Listen for auth success to reload profile
    const handleAuthSuccess = () => {
      console.log("[ProfileTab] Auth success - reloading profile");
      void (async () => {
        const settingsResponse = await gateway.send("settings:get");
        const settingsData = settingsResponse.data as {
          profile?: {
            name?: string;
            email?: string;
            imageUrl?: string;
            profileImageSyncPending?: boolean;
          };
        };
        const localImageUrl = settingsData?.profile?.imageUrl ?? "";
        const profileImageSyncPending =
          settingsData?.profile?.profileImageSyncPending === true;

        const refreshResult = await window.electronAPI.papr.refreshProfile();
        const response =
          refreshResult.success && refreshResult.profile
            ? refreshResult
            : await window.electronAPI.papr.getProfile();
        if (response.success && response.profile) {
          setPaprProfile(response.profile);
          setName(
            settingsData?.profile?.name ??
              response.profile.displayName ??
              "",
          );
          setEmail(
            settingsData?.profile?.email ?? response.profile.email ?? "",
          );
          setImageUrl(
            resolveDisplayProfileImage(
              localImageUrl,
              response.profile.profileImage ?? "",
              profileImageSyncPending,
            ),
          );
          void profileStore.loadProfile({ force: true });
        }
      })();
    };

    const handleLogoutSuccess = () => {
      setPaprProfile(null);
    };

    window.addEventListener("papr-auth-success", handleAuthSuccess);
    window.addEventListener("papr-logout-success", handleLogoutSuccess);
    return () => {
      window.removeEventListener("papr-auth-success", handleAuthSuccess);
      window.removeEventListener("papr-logout-success", handleLogoutSuccess);
    };
  }, []);

  const saveProfileFields = async (fields: {
    name: string;
    email: string;
    imageUrl: string;
  }) => {
    const hasImage = Boolean(fields.imageUrl.trim());
    await persistProfileFields({
      ...fields,
      profileImageSyncPending: hasImage,
    });
    profileStore.setProfile(fields);

    const loginStatus = await window.electronAPI.papr.checkLoginStatus();
    if (!loginStatus.success || !loginStatus.isLoggedIn) {
      return;
    }

    const syncResult = await syncProfileImageToCloud(fields);

    if (!syncResult.success) {
      console.warn("[ProfileTab] Cloud profile sync failed:", syncResult.error);
      await persistProfileFields({
        ...fields,
        profileImageSyncPending: hasImage,
      });
      return;
    }

    if (syncResult.cloudUrl) {
      const cloudUrl = syncResult.cloudUrl;
      await persistProfileFields({
        ...fields,
        imageUrl: cloudUrl,
        profileImageSyncPending: false,
      });
      profileStore.setProfile({ imageUrl: cloudUrl });
      setImageUrl(cloudUrl);
      setPaprProfile((current) =>
        current ? { ...current, profileImage: cloudUrl } : current,
      );
      return;
    }

    await persistProfileFields({
      ...fields,
      profileImageSyncPending: false,
    });
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) return;
    if (file.size > 5 * 1024 * 1024) {
      alert("Image must be under 5MB");
      return;
    }

    setSaving(true);
    try {
      const dataUrl = await resizeProfilePhoto(file);
      setImageUrl(dataUrl);
      await saveProfileFields({ name, email, imageUrl: dataUrl });
    } catch (err) {
      console.error("[ProfileTab] Photo upload error:", err);
      alert("Could not save profile photo. Please try again.");
    } finally {
      setSaving(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemovePhoto = async () => {
    setImageUrl("");
    if (fileInputRef.current) fileInputRef.current.value = "";

    setSaving(true);
    try {
      await saveProfileFields({ name, email, imageUrl: "" });
    } catch (err) {
      console.error("[ProfileTab] Photo remove error:", err);
      alert("Could not remove profile photo. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveProfileFields({ name, email, imageUrl });
    } catch (err) {
      console.error("[ProfileTab] Save error:", err);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <div className="settings-content">
        <div className="settings-section">Loading profile...</div>
      </div>
    );
  }

  return (
    <div className="settings-content">
      <PaprLoginSection
        onApiKeyReceived={() => undefined}
        profileFields={{
          name,
          email,
          imageUrl,
          saving,
          connectedSince: paprProfile?.authenticatedAt,
          onNameChange: setName,
          onEmailChange: setEmail,
          onPhotoUpload: handlePhotoUpload,
          onRemovePhoto: () => void handleRemovePhoto(),
          onSave: handleSave,
          onSyncFromPapr: paprProfile
            ? () => {
                setName(paprProfile.displayName ?? "");
                setEmail(paprProfile.email ?? "");
                setImageUrl(paprProfile.profileImage ?? "");
              }
            : undefined,
          fileInputRef,
        }}
      />
    </div>
  );
}

function PrivacyTab() {
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const telemetryApi = window.electronAPI?.telemetry;

  useEffect(() => {
    const loadAll = async () => {
      try {
        if (telemetryApi) {
          const r = await telemetryApi.getEnabled();
          setTelemetryEnabled(r.enabled);
        }
      } catch { /* use defaults */ }
      setLoaded(true);
    };
    void loadAll();
  }, [telemetryApi]);

  const handleTelemetryChange = async (next: boolean) => {
    if (!telemetryApi) return;
    setSaving(true);
    try {
      const result = await telemetryApi.setEnabled(next);
      if (result.success) {
        setTelemetryEnabled(result.enabled);
        if (!next) {
          trackEvent("paprwork_telemetry_toggled", { enabled: false } as Record<string, unknown>);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <div className="settings-content">
        <div className="settings-section">Loading privacy settings...</div>
      </div>
    );
  }

  if (!telemetryApi) {
    return (
      <div className="settings-content">
        <div className="settings-section">
          <h2 className="settings-section__title">Privacy</h2>
          <p className="settings-section__description">
            Anonymous usage statistics can be configured in the desktop app
            (Electron). This build does not expose telemetry controls.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-content">
      <div className="settings-section">
        <h2 className="settings-section__title">Privacy &amp; Analytics</h2>
        <p className="settings-section__description">
          Help us improve Paprwork by sharing anonymous usage data. This data is
          used to identify bugs, fix crashes, improve performance, and
          understand which features are most valuable — so we can build a better
          product for you.
        </p>

        <label className="permission-option" style={{ marginTop: "1rem" }}>
          <input
            type="checkbox"
            checked={telemetryEnabled}
            disabled={saving}
            onChange={(e) => void handleTelemetryChange(e.target.checked)}
          />
          <div className="permission-card">
            <div className="permission-header">
              <h4>Help improve Paprwork</h4>
            </div>
            <p>
              Share anonymous usage statistics, crash reports, and performance
              data to help us fix issues and build better features. You can
              turn this off at any time.
            </p>
          </div>
        </label>

        <div style={{ marginTop: "1.25rem", padding: "0.75rem 1rem", background: "var(--bg-secondary, #f5f5f7)", borderRadius: "8px", fontSize: "0.8rem", color: "var(--text-secondary, #666)" }}>
          <strong style={{ display: "block", marginBottom: "0.35rem" }}>What we collect</strong>
          <span>Feature usage (e.g. chat started, app created), error reports, and performance metrics.</span>
          <br /><br />
          <strong style={{ display: "block", marginBottom: "0.35rem" }}>What we never collect</strong>
          <span>Your messages, file contents, API keys, prompts, or any personal data. All events are
          anonymous unless you&apos;re signed in with Papr.</span>
        </div>
      </div>
    </div>
  );
}

function PermissionsTab() {
  const [permissionLevel, setPermissionLevel] = useState<
    "open" | "moderate" | "strict"
  >("open");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const response = await gateway.send("settings:get");
        const data = response.data as {
          permissions?: { permissionLevel?: string };
        };
        if (data?.permissions?.permissionLevel) {
          setPermissionLevel(
            data.permissions.permissionLevel as "open" | "moderate" | "strict",
          );
        }
        setLoaded(true);
      } catch (err) {
        console.error("[PermissionsTab] Load error:", err);
        setLoaded(true);
      }
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await gateway.send("settings:save-permissions", {
        permissionLevel,
      });
    } catch (err) {
      console.error("[PermissionsTab] Save error:", err);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <div className="settings-content">
        <div className="settings-section">Loading permissions...</div>
      </div>
    );
  }

  return (
    <div className="settings-content settings-content--full-width">
      <div className="settings-section">
        <h2 className="settings-section__title">Agent Permissions</h2>

        <div className="permission-level-grid">
          {/* Open */}
          <label className="permission-option">
            <input
              type="radio"
              name="permission-level"
              value="open"
              checked={permissionLevel === "open"}
              onChange={(e) => setPermissionLevel(e.target.value as "open")}
            />
            <div className="permission-card">
              <div className="permission-header">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <h4>Open</h4>
                <span className="badge badge-success">Recommended</span>
              </div>
              <p>Agents can run most commands freely</p>
              <ul className="permission-list">
                <li>✓ File operations (read, create, edit)</li>
                <li>✓ Install packages (npm, pip)</li>
                <li>✓ Network requests and API calls</li>
                <li>✓ Create and manage jobs</li>
                <li>
                  ⚠️ Asks only for destructive operations (rm, system changes)
                </li>
              </ul>
            </div>
          </label>

          {/* Moderate */}
          <label className="permission-option">
            <input
              type="radio"
              name="permission-level"
              value="moderate"
              checked={permissionLevel === "moderate"}
              onChange={(e) => setPermissionLevel(e.target.value as "moderate")}
            />
            <div className="permission-card">
              <div className="permission-header">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <h4>Moderate</h4>
              </div>
              <p>Balance between autonomy and control</p>
              <ul className="permission-list">
                <li>✓ File operations (read, create, edit)</li>
                <li>✓ Create and manage jobs</li>
                <li>⚠️ Asks before installing packages</li>
                <li>⚠️ Asks before network requests</li>
                <li>⚠️ Asks before system commands requiring password</li>
              </ul>
            </div>
          </label>

          {/* Strict */}
          <label className="permission-option">
            <input
              type="radio"
              name="permission-level"
              value="strict"
              checked={permissionLevel === "strict"}
              onChange={(e) => setPermissionLevel(e.target.value as "strict")}
            />
            <div className="permission-card">
              <div className="permission-header">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <h4>Strict</h4>
                <span className="badge badge-warning">High Security</span>
              </div>
              <p>Maximum control and confirmation</p>
              <ul className="permission-list">
                <li>⚠️ Asks before reading files</li>
                <li>⚠️ Asks before writing files</li>
                <li>⚠️ Asks before network requests</li>
                <li>⚠️ Asks before installing packages</li>
                <li>⚠️ Asks before using API keys</li>
                <li>⚠️ Asks before creating/running jobs</li>
              </ul>
            </div>
          </label>
        </div>
      </div>

      <div className="settings-actions">
        <button
          className="settings-btn settings-btn--primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save Permissions"}
        </button>
      </div>
    </div>
  );
}

// ===== About Tab =====

function AboutTab() {
  const { createChat } = useChat();
  const { createTab, switchToTab } = useTabs();
  const {
    currentVersion,
    updateStatus,
    checkForUpdates,
    installUpdate,
    isChecking,
    isDownloading,
    isUpdateReady,
    hasUpdate,
  } = useAppUpdater();

  const handleFeedbackChat = (kind: "bug" | "feature") => {
    void startPlatformFeedbackChat(kind, createChat, createTab, switchToTab);
  };


  const getStatusDisplay = () => {
    if (!updateStatus) {
      return { text: "Ready to check for updates", color: "default" };
    }

    switch (updateStatus.status) {
      case "checking":
        return { text: "Checking for updates...", color: "default" };
      case "available":
        return {
          text: `Update available: v${updateStatus.version}`,
          color: "success",
        };
      case "downloading":
        return {
          text: `Downloading update... ${updateStatus.percent || 0}%`,
          color: "info",
        };
      case "ready":
        return {
          text: `Update ready to install: v${updateStatus.version}`,
          color: "success",
        };
      case "not-available":
        return { text: "You're up to date!", color: "default" };
      case "error":
        return {
          text: updateStatus.error || "Update check failed",
          color: "error",
        };
      default:
        return { text: "Unknown status", color: "default" };
    }
  };

  const statusDisplay = getStatusDisplay();

  return (
    <div className="settings-content">
      <div className="settings-section">
        <h2 className="settings-section__title">About Papr Work</h2>

        {/* App Info Card */}
        <div className="about-card">
          <div className="about-header about-header--with-action">
            <div className="about-header__main">
              <div className="about-logo">
                <img
                  src="/images/papr-logo.svg"
                  alt="Papr Work"
                  className="about-logo__image"
                />
              </div>
              <div className="about-info">
                <h3>Papr Work</h3>
                <p className="about-version">Version {currentVersion}</p>
                <span
                  className={`about-update-status about-update-status--${statusDisplay.color}`}
                >
                  {statusDisplay.text}
                </span>
              </div>
            </div>
            <div className="about-header__action">
              {isUpdateReady ? (
                <button
                  className="settings-btn settings-btn--primary about-update-btn"
                  onClick={installUpdate}
                >
                  Install & Restart
                </button>
              ) : isDownloading ? (
                <button
                  className="settings-btn settings-btn--secondary about-update-btn"
                  disabled
                >
                  <div className="spinner" />
                  {updateStatus?.percent || 0}%
                </button>
              ) : (
                <button
                  className="settings-btn settings-btn--primary about-update-btn"
                  onClick={checkForUpdates}
                  disabled={isChecking}
                >
                  {isChecking ? (
                    <>
                      <div className="spinner" />
                      Checking...
                    </>
                  ) : (
                    "Check for Updates"
                  )}
                </button>
              )}
            </div>
          </div>

          {hasUpdate && updateStatus?.releaseNotes && (
            <div className="release-notes">
              <h4>Update notes</h4>
              <div className="release-notes-content">
                {updateStatus.releaseNotes}
              </div>
            </div>
          )}

          {updateStatus?.status === "error" && updateStatus.error && (
            <div className="update-error-notice">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <div>
                <strong>Update check failed</strong>
                <p>{updateStatus.error}</p>
                {updateStatus.recoveryHint && (
                  <p className="update-recovery-hint">{updateStatus.recoveryHint}</p>
                )}
                {updateStatus.error.includes("not packaged") && (
                  <p className="dev-mode-hint">
                    Auto-updates only work in production builds. Run{" "}
                    <code>npm run dist:mac</code> to test in a packaged app.
                  </p>
                )}
              </div>
            </div>
          )}

          <p className="about-description">
            AI-powered desktop assistant built with TypeScript and Mastra
          </p>

          <div className="about-links">
            <a
              href="https://github.com/Papr-ai/paprwork"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              GitHub
            </a>
            <a
              href="https://papr.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              Website
            </a>
            <button
              type="button"
              className="about-link"
              onClick={() => handleFeedbackChat("bug")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              Report Issue
            </button>
            <button
              type="button"
              className="about-link"
              onClick={() => handleFeedbackChat("feature")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              Feature Request
            </button>
          </div>
        </div>

        {currentVersion === "2.2.8" && (
          <div className="about-card">
            <h3>What's New in v2.2.8</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Sync Architecture V2</strong>
                <p>
                  Unified sync coordinator with per-layer status for Git, Turso,
                  publish catalog, and edge cache — no more misleading single
                  &quot;synced&quot; chip.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Manual Upload Mode</strong>
                <p>
                  Per-app auto vs manual upload — test locally and push to cloud
                  only when ready with Upload now.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Turso Oplog Sync</strong>
                <p>
                  Event-driven delta push/pull with sync sessions, max-wait
                  debounce, and safer bidirectional row sync.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Cloud Apps & Sharing</strong>
                <p>
                  Embedded app agent chat on cloud, require-sign-in and per-user
                  database isolation, profile photo cloud sync, and friendlier
                  subscription error banners.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.2.8"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {/* License & Credits */}
        <div className="about-card">
          <h3>License & Credits</h3>
          <p className="about-license-text">
            Papr Work is open source software licensed under AGPL-3.0
          </p>

          <p className="about-license-text">
            © 2024-2026 Papr, Inc. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
}
