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
import "./SettingsView.css";

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("models");
  const [scrollToPickerModels, setScrollToPickerModels] = useState(false);

  useEffect(() => {
    trackEvent("paprwork_settings_opened", { section: "models" } as Record<string, unknown>);
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

  return (
    <div className="settings-view">
      <div className="settings-view__header">
        <h1 className="settings-view__title">Settings</h1>
      </div>

      {/* Tabs */}
      <div className="settings-view__tabs">
        <button
          className={`settings-tab ${activeTab === "models" ? "settings-tab--active" : ""}`}
          onClick={() => {
            setActiveTab("models");
            setScrollToPickerModels(false);
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v6m0 6v6M5.64 5.64l4.24 4.24m4.24 4.24l4.24 4.24M1 12h6m6 0h6M5.64 18.36l4.24-4.24m4.24-4.24l4.24-4.24" />
          </svg>
          AI Models
        </button>
        <button
          className={`settings-tab ${activeTab === "keys" ? "settings-tab--active" : ""}`}
          onClick={() => setActiveTab("keys")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
          </svg>
          Integration Keys
        </button>
        <button
          className={`settings-tab ${activeTab === "cloud" ? "settings-tab--active" : ""}`}
          onClick={() => setActiveTab("cloud")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
          </svg>
          Cloud Sync
        </button>
        <button
          className={`settings-tab ${activeTab === "databases" ? "settings-tab--active" : ""}`}
          onClick={() => setActiveTab("databases")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
          </svg>
          Databases
        </button>
        <button
          className={`settings-tab ${activeTab === "migration" ? "settings-tab--active" : ""}`}
          onClick={() => setActiveTab("migration")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 3v12" />
            <path d="m8 11 4 4 4-4" />
            <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
          </svg>
          Migration
        </button>
        <button
          className={`settings-tab ${activeTab === "profile" ? "settings-tab--active" : ""}`}
          onClick={() => setActiveTab("profile")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          Profile
        </button>
        <button
          className={`settings-tab ${activeTab === "permissions" ? "settings-tab--active" : ""}`}
          onClick={() => setActiveTab("permissions")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          Permissions
        </button>
        <button
          className={`settings-tab ${activeTab === "privacy" ? "settings-tab--active" : ""}`}
          onClick={() => setActiveTab("privacy")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          Privacy
        </button>
        <button
          className={`settings-tab ${activeTab === "about" ? "settings-tab--active" : ""}`}
          onClick={() => setActiveTab("about")}
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
          About
        </button>
      </div>

      {/* Content */}
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
          profile?: { name?: string; email?: string; imageUrl?: string };
        };

        // Load Papr profile first
        const paprResponse = await window.electronAPI.papr.getProfile();
        if (paprResponse.success && paprResponse.profile) {
          setPaprProfile(paprResponse.profile);
          
          // Pre-fill manual profile fields if empty
          if (data?.profile) {
            setName(data.profile.name ?? paprResponse.profile.displayName ?? "");
            setEmail(data.profile.email ?? paprResponse.profile.email ?? "");
            setImageUrl(data.profile.imageUrl ?? paprResponse.profile.profileImage ?? "");
          } else {
            // No manual profile yet - use Papr profile as defaults
            setName(paprResponse.profile.displayName ?? "");
            setEmail(paprResponse.profile.email ?? "");
            setImageUrl(paprResponse.profile.profileImage ?? "");
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
      console.log('[ProfileTab] Auth success - reloading profile');
      window.electronAPI.papr.getProfile().then((response) => {
        if (response.success && response.profile) {
          setPaprProfile(response.profile);
          // Auto-populate if manual fields are empty
          if (!name) setName(response.profile.displayName ?? "");
          if (!email) setEmail(response.profile.email ?? "");
          if (!imageUrl) setImageUrl(response.profile.profileImage ?? "");
        }
      });
    };

    window.addEventListener('papr-auth-success', handleAuthSuccess);
    return () => window.removeEventListener('papr-auth-success', handleAuthSuccess);
  }, []);

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type and size
    if (!file.type.startsWith("image/")) return;
    if (file.size > 5 * 1024 * 1024) {
      alert("Image must be under 5MB");
      return;
    }

    // Convert to base64 data URL for storage
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setImageUrl(dataUrl);
    };
    reader.readAsDataURL(file);
  };

  const handleRemovePhoto = () => {
    setImageUrl("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await gateway.send("settings:save-profile", { name, email, imageUrl });
      // Update the global profile store so chat reflects changes immediately
      profileStore.setProfile({ name, email, imageUrl });
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
      {/* Papr Profile Section - Shows info fetched from dashboard */}
      {paprProfile && (
        <div className="settings-section" style={{ marginBottom: '24px' }}>
          <h2 className="settings-section__title">Papr Account</h2>
          <p className="settings-section__description">
            Profile synced from your Papr account
          </p>

          <div className="form-group">
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '16px',
              padding: '16px',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.05)',
              borderRadius: '12px',
            }}>
              {paprProfile.profileImage ? (
                <img 
                  src={paprProfile.profileImage} 
                  alt={paprProfile.displayName || paprProfile.email}
                  style={{
                    width: '48px',
                    height: '48px',
                    borderRadius: '50%',
                    objectFit: 'cover',
                  }}
                />
              ) : (
                <div style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '50%',
                  background: 'rgba(255, 255, 255, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </div>
              )}
              <div style={{ flex: 1 }}>
                <div style={{ 
                  fontSize: '15px', 
                  fontWeight: 500, 
                  color: 'var(--text-primary)',
                  marginBottom: '4px',
                }}>
                  {paprProfile.displayName || paprProfile.email}
                </div>
                <div style={{ 
                  fontSize: '13px', 
                  color: 'var(--text-secondary)',
                }}>
                  {paprProfile.email}
                </div>
                <div style={{ 
                  fontSize: '12px', 
                  color: 'var(--text-tertiary)',
                  marginTop: '4px',
                }}>
                  Connected {new Date(paprProfile.authenticatedAt).toLocaleDateString()}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="settings-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div>
            <h2 className="settings-section__title">Your Profile</h2>
            <p className="settings-section__description">
              {paprProfile 
                ? "Override your Papr account info or keep it synced" 
                : "This information helps personalize your experience and chat messages"}
            </p>
          </div>
          {paprProfile && (
            <button
              className="settings-btn settings-btn--secondary"
              onClick={() => {
                setName(paprProfile.displayName ?? "");
                setEmail(paprProfile.email ?? "");
                setImageUrl(paprProfile.profileImage ?? "");
              }}
              style={{ marginTop: '-8px' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
              </svg>
              Sync from Papr
            </button>
          )}
        </div>

        {/* Profile Photo Upload */}
        <div className="form-group">
          <label className="form-label">Profile Photo</label>
          <div className="profile-photo-upload">
            <div
              className="profile-photo-preview"
              onClick={() => fileInputRef.current?.click()}
            >
              {imageUrl ? (
                <img src={imageUrl} alt="Profile" className="profile-photo-img" />
              ) : (
                <div className="profile-photo-placeholder">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </div>
              )}
              <div className="profile-photo-overlay">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </div>
            </div>
            <div className="profile-photo-actions">
              <button
                className="settings-btn settings-btn--secondary"
                onClick={() => fileInputRef.current?.click()}
              >
                {imageUrl ? "Change Photo" : "Upload Photo"}
              </button>
              {imageUrl && (
                <button
                  className="settings-btn settings-btn--ghost"
                  onClick={handleRemovePhoto}
                >
                  Remove
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handlePhotoUpload}
              style={{ display: "none" }}
            />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Name</label>
          <input
            type="text"
            className="form-input"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label className="form-label">
            Email <span className="form-label__optional">(optional)</span>
          </label>
          <input
            type="email"
            className="form-input"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>

      <div className="settings-actions">
        <button
          className="settings-btn settings-btn--primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save Profile"}
        </button>
      </div>
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
        <h2 className="settings-section__title">About Paprwork</h2>

        {/* App Info Card */}
        <div className="about-card">
          <div className="about-header">
            <div className="about-logo">
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
            <div className="about-info">
              <h3>Paprwork V2</h3>
              <p className="about-version">Version {currentVersion}</p>
            </div>
          </div>

          <p className="about-description">
            AI-powered desktop assistant built with TypeScript and Mastra
          </p>

          <div className="about-links">
            <a
              href="https://github.com/amirkabbara/paprwork-v2"
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
            <a
              href="https://github.com/amirkabbara/paprwork-v2/issues"
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
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              Report Issue
            </a>
          </div>
        </div>

        {/* Update Section */}
        <div className="about-card">
          <div className="about-update-header">
            <h3>Software Updates</h3>
            <span className={`update-status-badge update-status-badge--${statusDisplay.color}`}>
              {statusDisplay.text}
            </span>
          </div>

          {hasUpdate && updateStatus?.releaseNotes && (
            <div className="release-notes">
              <h4>What's New</h4>
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
                <strong>Update Check Failed</strong>
                <p>{updateStatus.error}</p>
                {updateStatus.recoveryHint && (
                  <p className="update-recovery-hint">{updateStatus.recoveryHint}</p>
                )}
                {updateStatus.error.includes("not packaged") && (
                  <p className="dev-mode-hint">
                    💡 Tip: Auto-updates only work in production builds. To test updates, 
                    run <code>npm run dist:mac</code> to create a packaged app.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="about-update-actions">
            {isUpdateReady ? (
              <button
                className="settings-btn settings-btn--primary"
                onClick={installUpdate}
              >
                Install Update & Restart
              </button>
            ) : isDownloading ? (
              <button className="settings-btn settings-btn--secondary" disabled>
                <div className="spinner" />
                Downloading... {updateStatus?.percent || 0}%
              </button>
            ) : (
              <button
                className="settings-btn settings-btn--secondary"
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

          <p className="about-update-note">
            Paprwork automatically checks for updates on startup and every 4
            hours. Updates install only when you click Restart to update.
          </p>
        </div>

        {/* License & Credits */}
        <div className="about-card">
          <h3>License & Credits</h3>
          <p className="about-license-text">
            Paprwork V2 is open source software licensed under AGPL-3.0
          </p>

          <p className="about-license-text">
            © 2024-2026 Papr, Inc. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
}
