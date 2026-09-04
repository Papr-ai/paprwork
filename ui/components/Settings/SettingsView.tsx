/**
 * SettingsView - Settings page with tabs for API Keys, Profile, and Permissions
 * Reference: Paprwork v1 settings modal
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useProfileStore } from "../../stores/profileStore";
import { useAppUpdater } from "../../hooks/useAppUpdater";
import { gateway } from "../../src/lib/gateway";
import { trackEvent } from "../../lib/telemetry";
import type { SettingsTab } from "../../types/settings";
import { AIModelsTab } from "./AIModelsTab";
import { IntegrationKeysTab } from "./IntegrationKeysTab";
import { CloudSyncTab } from "./CloudSyncTab";
import { DatabasesTab } from "./DatabasesTab";
import { ConnectedPlatformsTab } from "./ConnectedPlatformsTab";
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
import {
  readSettingsViewTab,
  writeSettingsViewTab,
} from "../../utils/settingsViewTabPersistence";
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
    id: "platforms",
    label: "Platform Connections",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
        <rect width="4" height="12" x="2" y="9" />
        <circle cx="4" cy="4" r="2" />
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
  const [activeTab, setActiveTabState] = useState<SettingsTab>(
    () => readSettingsViewTab() ?? "profile",
  );
  const [scrollToPickerModels, setScrollToPickerModels] = useState(false);

  const setActiveTab = useCallback((tab: SettingsTab) => {
    setActiveTabState(tab);
    writeSettingsViewTab(tab);
  }, []);

  const openedSectionRef = useRef(activeTab);
  useEffect(() => {
    trackEvent("paprwork_settings_opened", {
      section: openedSectionRef.current,
    } as Record<string, unknown>);
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
  }, [setActiveTab]);

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
          {activeTab === "platforms" && <ConnectedPlatformsTab />}
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

  const applyProfileState = (
    data: {
      profile?: {
        name?: string;
        email?: string;
        imageUrl?: string;
        profileImageSyncPending?: boolean;
      };
    } | undefined,
    paprResponse: {
      success: boolean;
      profile?: {
        userId: string;
        email: string;
        displayName?: string;
        profileImage?: string;
        authenticatedAt: string;
      };
    },
  ) => {
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
      return;
    }

    if (data?.profile) {
      setName(data.profile.name ?? "");
      setEmail(data.profile.email ?? "");
      setImageUrl(data.profile.imageUrl ?? "");
    }
  };

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

        const paprResponse = await window.electronAPI.papr.getProfile();
        applyProfileState(data, paprResponse);
        setLoaded(true);

        // Refresh from Parse in background — do not block Settings UI on cloud latency.
        const loginStatus = await window.electronAPI.papr.checkLoginStatus();
        if (!loginStatus.success || !loginStatus.isLoggedIn) {
          return;
        }

        void window.electronAPI.papr.refreshProfile().then((refreshResult) => {
          if (!refreshResult.success || !refreshResult.profile) {
            return;
          }
          applyProfileState(data, refreshResult);
        });
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

        const cachedResponse = await window.electronAPI.papr.getProfile();
        if (cachedResponse.success && cachedResponse.profile) {
          applyProfileState(settingsData, cachedResponse);
        }

        void window.electronAPI.papr.refreshProfile().then((refreshResult) => {
          const response =
            refreshResult.success && refreshResult.profile
              ? refreshResult
              : cachedResponse;
          if (response.success && response.profile) {
            applyProfileState(settingsData, response);
            void profileStore.loadProfile({ force: true });
          }
        });
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
            AI workspace that automatically builds your company brain and runs your work
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

        {currentVersion === "2.5.8" && (
          <div className="about-card">
            <h3>What's New in v2.5.8</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Turso Scratch Tables &amp; Sync Hardening</strong>
                <p>
                  Tables prefixed with _ are treated as local-only scratch
                  (backups, temp data). No-PK warnings now include a clear
                  rebuild recipe instead of misleading drift-heal advice.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Workspace Goals &amp; Home Brief</strong>
                <p>
                  Goals in IDENTITY.md now drive the Home brief, Sleep job,
                  and Wiki Writer for personalized daily updates.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Agent &amp; Chat Improvements</strong>
                <p>
                  Separate chat and job concurrency pools with waiting-for-slot
                  UI, per-chat model selection, and improved chat history
                  dropdown.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Database Validation &amp; Stability</strong>
                <p>
                  Replica-safe registry schema reads, data contract enforcement,
                  honest job run status, FSEvents tree watchers, and Claude
                  Opus/Fable 5.1 API-key fixes.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.5.8"
              target="_blank"
              rel="noopener noreferrer"
              className="about-card__link"
            >
              View release notes on GitHub
            </a>
          </div>
        )}

        {currentVersion === "2.5.7" && (
          <div className="about-card">
            <h3>What's New in v2.5.7</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Mini-App SDK Packaged Fix</strong>
                <p>
                  SDK discovery now works when auto-update deltas omit .ts
                  sources — falls back to compiled papr-*.js or a static
                  catalog so /__papr__/ routes keep working.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Release Packaging Guard</strong>
                <p>
                  Package build test now verifies papr-sdk.ts is included in
                  the ASAR bundle so this regression is caught before ship.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.5.7"
              target="_blank"
              rel="noopener noreferrer"
              className="about-card__link"
            >
              View release notes on GitHub
            </a>
          </div>
        )}

        {currentVersion === "2.5.6" && (
          <div className="about-card">
            <h3>What's New in v2.5.6</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Turso Replica Worker Isolation</strong>
                <p>
                  Replica sync runs in a separate worker so a panic cannot
                  take down the gateway, with WAL watermark repair before
                  engine abort.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>FD &amp; Process Stability</strong>
                <p>
                  Child-process stream cleanup and EBADF recovery prevent
                  file-descriptor leaks from bash, git, and job spawns.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Agent &amp; Memory Reliability</strong>
                <p>
                  Recover pending tool calls on length truncation, dual-send
                  Papr Memory user identity, and scheduler retry-storm fixes.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Sync &amp; Startup Hardening</strong>
                <p>
                  Metadata outbox dedupe, auth wall IPC fixes, job secret
                  leak prevention, and per-app agent work telemetry.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.5.6"
              target="_blank"
              rel="noopener noreferrer"
              className="about-card__link"
            >
              View release notes on GitHub
            </a>
          </div>
        )}

        {currentVersion === "2.5.5" && (
          <div className="about-card">
            <h3>What's New in v2.5.5</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>LinkedIn &amp; Platform Browser Auth</strong>
                <p>
                  Real Chrome profile login for connected platforms with
                  embedded browser tabs, CDP bridge, and improved LinkedIn
                  session validation.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Replica Migration Dual-Apply</strong>
                <p>
                  Safer schema migrations with pairing, verification, and
                  reconcile sync so replica and primary stay aligned.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Daily Brief Write Guard</strong>
                <p>
                  Protected daily brief payloads with deduplication and safer
                  home dashboard brief persistence.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Workspace Switch &amp; Auth UI</strong>
                <p>
                  Papr auth browser tab, improved workspace switch reload, and
                  custom platform connection support.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.5.5"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.5.4" && (
          <div className="about-card">
            <h3>What's New in v2.5.4</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Home Dashboard Registry DB</strong>
                <p>
                  Bundled home dashboard now ships with its own registry
                  database migration and <code>save_brief.py</code> job asset
                  for reliable daily brief persistence.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>FD Watchdog &amp; Pressure Recovery</strong>
                <p>
                  Gateway monitors file descriptor pressure and recovers from
                  watcher leaks to prevent silent resource exhaustion.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Wiki &amp; Workspace Switch Hardening</strong>
                <p>
                  Improved wiki library sections, safer workspace switching,
                  and shared shell exec utilities for more reliable bash tools.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.5.4"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.5.3" && (
          <div className="about-card">
            <h3>What's New in v2.5.3</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Job Replica DB Routing</strong>
                <p>
                  Jobs now route replica database reads and writes through the
                  gateway instead of opening SQLite directly — fixing stale
                  reads and WAL wedge issues after job runs.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Replica Job Quiesce</strong>
                <p>
                  Database jobs quiesce replica push/pull while running so
                  concurrent sync does not corrupt sidecar state.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Gateway Connection Indicator</strong>
                <p>
                  Clearer connection status in the sidebar with reconnect
                  feedback and improved update banner behavior.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Platform Agent Browser</strong>
                <p>
                  Social platform login flows use a dedicated agent browser
                  with proper Chrome environment for reliable session capture.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.5.3"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.5.2" && (
          <div className="about-card">
            <h3>What's New in v2.5.2</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Community Catalog Dedupe</strong>
                <p>
                  Smarter catalog merging prefers real app names over slug-only
                  entries and deprioritizes throwaway <code>e2e-*</code> test
                  slugs when workspace and remote catalogs overlap.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.5.2"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.5.1" && (
          <div className="about-card">
            <h3>What's New in v2.5.1</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Replica Sidecar &amp; Checkpoint Recovery</strong>
                <p>
                  Hardened sidecar wedge repair, checkpoint recovery, and
                  offline Turso credential caching for more reliable replica
                  reconnect after sleep or network blips.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Cutover Migration Authority</strong>
                <p>
                  Safer legacy-to-replica cutover with explicit migration
                  ledger authority checks before applying schema changes.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Chat &amp; Home Dashboard Polish</strong>
                <p>
                  Follow-scroll in agent chat, turn-end diagnostics, and
                  refreshed home dashboard styling.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.5.1"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.5.0" && (
          <div className="about-card">
            <h3>What's New in v2.5.0</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Turso Replica Sync in Packaged Builds</strong>
                <p>
                  Desktop releases now ship with Plan A replica sync enabled
                  (<code>replica-records</code>) and production cutover allowed —
                  matching dev behavior without a local <code>.env.local</code>.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Sync Metadata on Upload</strong>
                <p>
                  Upload now flushes registry metadata alongside app code so
                  cloud databases stay aligned after publish.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Home Dashboard &amp; Daily Brief</strong>
                <p>
                  Updated home dashboard data contract, brief date handling,
                  and Home Today wiki improvements.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.5.0"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.4.9" && (
          <div className="about-card">
            <h3>What's New in v2.4.9</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Replica Sync Duplicate Row Fix</strong>
                <p>
                  After replica cutover, cloud db-changed events now pull remote
                  first instead of pushing stale local fingerprints — preventing
                  duplicate rows in linked databases.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Home &amp; Wiki Today View</strong>
                <p>
                  New Home Today dashboard in Memory with entity sections,
                  related memories, and tasks — plus improved wiki editing and
                  navigation.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.4.9"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.4.8" && (
          <div className="about-card">
            <h3>What's New in v2.4.8</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Cloud App Agent Chat</strong>
                <p>
                  Richer in-app agent chat with activity cards, tool display
                  labels, and improved cloud streaming for published mini-apps.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Faster Cloud App Host</strong>
                <p>
                  Direct GitHub repo access, deploy snapshots, backend DB proxy,
                  and warm-cache loading cut cold-start latency for cloud apps.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Replica Recovery &amp; Cutover</strong>
                <p>
                  Checkpoint recovery, sidecar wedge repair, legacy CDC purge,
                  and post-cutover verification for Turso embedded replicas.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Sub-Agent Cloud Integrity</strong>
                <p>
                  Cloud runs now hydrate sub-agent metadata from the registry
                  with integrity checks before delegation.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.4.8"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.4.7" && (
          <div className="about-card">
            <h3>What's New in v2.4.7</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Turso Embedded Replica (Plan A)</strong>
                <p>
                  Desktop databases now sync through Turso embedded replicas with
                  primary-authority writes, offline outbox draining, and
                  cutover tooling for legacy workspaces.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>paprDb Agent Tools</strong>
                <p>
                  New agent-facing database API for exec, migrations, sync
                  status, push, and pull — with guards against direct SQLite
                  access when replica mode is active.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>App Tool Previews in Chat</strong>
                <p>
                  Mini-app tool calls now render inline previews in the chat
                  stream so you can see app output without switching tabs.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Workspace Readiness &amp; Job Cleanup</strong>
                <p>
                  Safer workspace switching with readiness guards, job
                  tombstones, cloud cleanup, and improved sync status in the
                  Cloud Sync tab.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.4.7"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.4.6" && (
          <div className="about-card">
            <h3>What's New in v2.4.6</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Sync Replica Genesis &amp; Schema Healing</strong>
                <p>
                  Smarter schema drift detection, batched migration shipping,
                  and workspace log replay so linked databases sync reliably
                  after schema changes.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Mini-App SDK Bundle</strong>
                <p>
                  Official SDK now includes <code>papr-sdk</code>, native
                  dialog shim, and version-check helpers — agents can build
                  richer mini-apps with less boilerplate.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Safer App Deletion</strong>
                <p>
                  Deleting an app now cleans up linked Turso databases and
                  sync artifacts, with a clearer confirmation modal.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Turso Sync Improvements</strong>
                <p>
                  Faster push scheduling, platform schema support, and better
                  sync status reporting in the Cloud Sync tab.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.4.6"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.4.5" && (
          <div className="about-card">
            <h3>What's New in v2.4.5</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Cloud Services Built In</strong>
                <p>
                  Packaged releases now ship with Papr Memory, app-repo writer,
                  and cloud app host URLs preconfigured — cloud sync works out
                  of the box after login.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Release Build Validation</strong>
                <p>
                  CI verifies all gateway service keys are present before
                  publishing installers, preventing broken cloud sync in
                  production builds.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.4.5"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.4.4" && (
          <div className="about-card">
            <h3>What's New in v2.4.4</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Faster Cloud Database Queries</strong>
                <p>
                  Mini-app database reads and writes are batched and pooled for
                  noticeably snappier cloud app performance.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Desktop Session Bridge</strong>
                <p>
                  Cloud catalog previews share your Papr login session with the
                  gateway so signed-in apps load without extra setup.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>App Tab Keep-Alive</strong>
                <p>
                  Switching tabs no longer reloads mini-apps — your app state
                  stays warm while you work across chats and settings.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Jobs &amp; Catalog Filters</strong>
                <p>
                  Filter jobs by app or delegation group, and browse the
                  community catalog with search and category filters.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.4.4"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.4.3" && (
          <div className="about-card">
            <h3>What's New in v2.4.3</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Install from Community Catalog</strong>
                <p>
                  Fork or track cloud apps directly from the community catalog
                  with a guided install flow and requirement checks.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Richer Catalog Preview</strong>
                <p>
                  Preview cloud apps in dedicated tabs with URL bar navigation,
                  persistent tab state, and session-based access validation.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Job–App Linkage</strong>
                <p>
                  Jobs now track which apps they belong to for clearer cloud
                  scheduling and execution capability routing.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.4.3"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.4.2" && (
          <div className="about-card">
            <h3>What's New in v2.4.2</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Job Cloud Status</strong>
                <p>
                  The Jobs view now shows whether each job last ran on desktop
                  or in the cloud, with live status from the cloud scheduler.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Build Fix</strong>
                <p>
                  Fixed a gateway compile error that blocked v2.4.1 from
                  building locally.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.4.2"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.4.1" && (
          <div className="about-card">
            <h3>What's New in v2.4.1</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Per-User Database Isolation</strong>
                <p>
                  Apps with per-user Turso sources now require Papr sign-in and
                  route each visitor to their own database replica.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Community Catalog Preview</strong>
                <p>
                  Browse and preview published apps from the community catalog
                  directly inside Paprwork without leaving the app.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Smarter Mini-App Access</strong>
                <p>
                  Team and shared published apps now correctly identify owners
                  and enforce read/write permissions for signed-in visitors.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.4.1"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.4.0" && (
          <div className="about-card">
            <h3>What's New in v2.4.0</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Sync V3 Architecture</strong>
                <p>
                  Cloud sync is rebuilt around per-app repos and a workspace log —
                  faster pushes, cleaner conflict handling, and no more stale
                  &quot;merge required&quot; noise on apps.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Smarter Cloud Publish</strong>
                <p>
                  Publishing and syncing mini-apps routes through the new app-repo
                  writer with clearer status in the Cloud Sync tab.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Auto-Update Reliability</strong>
                <p>
                  Restart-to-update on macOS no longer closes the window without
                  finishing the install — you should see the password prompt when
                  needed.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Scheduler &amp; Job Improvements</strong>
                <p>
                  Cloud-capable jobs defer correctly when dispatch is enabled, with
                  better migration ledger sync and execution capability detection.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.4.0"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.3.6" && (
          <div className="about-card">
            <h3>What's New in v2.3.6</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Silent Papr Web Sync</strong>
                <p>
                  Cloud workspace-chat infrastructure merges in the background —
                  no more confusing &quot;Merge remote changes&quot; on your apps.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Hidden Infrastructure Job</strong>
                <p>
                  The Papr Web Main Agent job no longer appears in Jobs or Cloud
                  Sync — it&apos;s managed automatically by the platform.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Papr Web Chat Routing</strong>
                <p>
                  Cloud agent sessions correctly route workspace-chat turns to the
                  main Pen instead of mini-app agent handlers.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.3.6"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.3.5" && (
          <div className="about-card">
            <h3>What's New in v2.3.5</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Workspace Switch Overlay</strong>
                <p>
                  Switching org or namespace shows a phased progress overlay so
                  you know tabs, apps, and sync are reloading safely.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Write Guard During Switch</strong>
                <p>
                  Cloud, Turso, and job writes are blocked mid-switch so data
                  from the old workspace cannot leak into the new one.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Per-Workspace Home Bundle</strong>
                <p>
                  Each workspace gets its own Daily Brief job and Home dashboard
                  data sources instead of sharing one fixed job ID.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Migration Verifier Fix</strong>
                <p>
                  SQL migration parsing accepts drop-and-recreate patterns and
                  stops failing on unverifiable statements.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Turso Sync Scoping</strong>
                <p>
                  Turso push state and linked DB watchers are scoped per workspace
                  for cleaner multi-team switching.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.3.5"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.3.4" && (
          <div className="about-card">
            <h3>What's New in v2.3.4</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Workspace Switch Reload</strong>
                <p>
                  Switching org or namespace now restores tabs, chats, apps, and
                  Memory focus per workspace instead of mixing state across teams.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Social Login Cookie Fix</strong>
                <p>
                  Improved Playwright cookie injection from Chrome and keychain —
                  prepare_browser sessions stay logged in reliably.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Community Apps Scoping</strong>
                <p>
                  Community catalog respects workspace assignment so apps from
                  other teams no longer appear in the wrong namespace.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Memory Wiki Per-Workspace</strong>
                <p>
                  Wiki library focus and setup state are cached per workspace for
                  faster context switching.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.3.4"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.3.3" && (
          <div className="about-card">
            <h3>What's New in v2.3.3</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Packaged Install Fix</strong>
                <p>
                  Default home dashboard and bundled jobs now install correctly
                  in production builds — resources unpacked from ASAR so fresh
                  installs get the full experience.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Social Login Automation</strong>
                <p>
                  New prepare_browser action injects your LinkedIn, Instagram,
                  or X session into agent browser tools for feed and messaging
                  automation.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Connected Platforms UI</strong>
                <p>
                  Improved Social Login tab with session status, refresh, and
                  clearer connect flows when the agent needs a platform.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Wiki Entity Rails</strong>
                <p>
                  Memory wiki now surfaces meetings, decisions, ideas, and
                  workflows alongside projects, people, and companies.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.3.3"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.3.2" && (
          <div className="about-card">
            <h3>What's New in v2.3.2</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Playwright in Packaged App</strong>
                <p>
                  Browser tools and Social Login now include Playwright in
                  production builds — fixes &quot;Cannot find package
                  playwright&quot; errors.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Playwright Auto-Install</strong>
                <p>
                  If the package or Chromium binary is missing, the app
                  auto-installs on first use instead of failing silently.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Mac Auto-Update Fix</strong>
                <p>
                  Release pipeline now verifies latest-mac.yml zip URLs match
                  uploaded artifacts — no more 404 on update download.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Social Login Timeouts</strong>
                <p>
                  Longer navigation timeouts for platform connect and session
                  refresh on slow networks.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.3.2"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.3.1" && (
          <div className="about-card">
            <h3>What's New in v2.3.1</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Cloud Sync Safety</strong>
                <p>
                  Fixes a critical bug where switching namespace could wipe
                  cloud data. Adds safety checks before git push.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Smarter App Delete</strong>
                <p>
                  New delete modal shows linked jobs, Turso databases, and
                  publish status — type the app name to confirm.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Auth Reliability</strong>
                <p>
                  Dynamic localhost ports, manual 6-digit code fallback, and
                  faster feedback when browser sign-in fails.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Job Delete + Turso Cleanup</strong>
                <p>
                  Delete jobs from the Jobs view with optional Turso cloud
                  database removal.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.3.1"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.3.0" && (
          <div className="about-card">
            <h3>What's New in v2.3.0</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Telegram Connected Platform</strong>
                <p>
                  Connect Telegram Web alongside LinkedIn, Instagram, Reddit,
                  Facebook, TikTok, and X — sessions stay fresh for job
                  automation.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Playwright Auto-Install</strong>
                <p>
                  Browser tools and Social Login now auto-download Chromium on
                  first use — no manual setup step required.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Published App Delete Fix</strong>
                <p>
                  Deleting a published mini-app now unpublishes from cloud first
                  with clear progress and reliable timeouts.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Cloud Sync Reliability</strong>
                <p>
                  Job ownership cache invalidates immediately when apps or jobs
                  are linked or unlinked — upload mode stays accurate.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.3.0"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

        {currentVersion === "2.2.9" && (
          <div className="about-card">
            <h3>What's New in v2.2.9</h3>
            <ul className="whats-new-list">
              <li className="whats-new-list__item">
                <strong>Connected Platforms</strong>
                <p>
                  New Social Login settings tab — connect LinkedIn, Instagram,
                  Reddit, Facebook, TikTok, and X with one click. Sessions stay
                  fresh in the background for job automation.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Cloud Job Status</strong>
                <p>
                  Faster job polling on cloud mini-apps — single-job status
                  lookup instead of loading the full jobs list.
                </p>
              </li>
              <li className="whats-new-list__item">
                <strong>Sync Performance</strong>
                <p>
                  Auto-upload checks no longer block the gateway during cloud
                  sync, keeping chat and tools responsive.
                </p>
              </li>
            </ul>
            <a
              href="https://github.com/Papr-ai/paprwork/releases/tag/v2.2.9"
              target="_blank"
              rel="noopener noreferrer"
              className="about-link whats-new-list__link"
            >
              View full release notes
            </a>
          </div>
        )}

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
