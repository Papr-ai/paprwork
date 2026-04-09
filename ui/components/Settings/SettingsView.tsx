/**
 * SettingsView - Settings page with tabs for API Keys, Profile, and Permissions
 * Reference: Paprwork v1 settings modal
 */

import React, { useState, useEffect, useMemo, useRef } from "react";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import { useProfileStore } from "../../stores/profileStore";
import { useCodeIndexing } from "../../hooks/useCodeIndexing";
import { useAppUpdater } from "../../hooks/useAppUpdater";
import { gateway } from "../../src/lib/gateway";
import type { CustomKeyInput, SettingsTab } from "../../types/settings";
import { OAuthSection } from "./OAuthSection";
import { PaprLoginSection } from "./PaprLoginSection";
import "./SettingsView.css";

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("keys");

  return (
    <div className="settings-view">
      <div className="settings-view__header">
        <h1 className="settings-view__title">Settings</h1>
      </div>

      {/* Tabs */}
      <div className="settings-view__tabs">
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
          API Keys
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
          className={`settings-tab ${activeTab === "memory" ? "settings-tab--active" : ""}`}
          onClick={() => setActiveTab("memory")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
          </svg>
          Memory
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
        {activeTab === "keys" && <APIKeysTab />}
        {activeTab === "profile" && <ProfileTab />}
        {activeTab === "permissions" && <PermissionsTab />}
        {activeTab === "privacy" && <PrivacyTab />}
        {activeTab === "memory" && <MemoryTab />}
        {activeTab === "about" && <AboutTab />}
      </div>
    </div>
  );
}

// Default keys that should always be shown
const DEFAULT_KEYS = [
  {
    name: "PAPR_API_KEY",
    description: "Papr Cloud API Key",
    hint: "For Papr cloud features and integrations",
  },
  {
    name: "ANTHROPIC_API_KEY",
    description: "Anthropic Claude API Key",
    hint: "For Claude models - console.anthropic.com",
  },
  {
    name: "OPENAI_API_KEY",
    description: "OpenAI API Key",
    hint: "For GPT models - platform.openai.com/api-keys",
  },
  {
    name: "GOOGLE_API_KEY",
    description: "Google AI API Key",
    hint: "For Gemini models - makersuite.google.com/app/apikey",
  },
];

interface KeyDisplayItem {
  id: string;
  name: string;
  description?: string;
  hint: string;
  hasValue: boolean;
  isDefault: boolean;
  addedAt?: string;
  permission: "always" | "ask";
  source?: "manual" | "oauth";
  managedBy?: "oauth";
  oauthProvider?: "openai" | "anthropic";
}

function APIKeysTab() {
  const {
    keys: customKeys,
    loading,
    error,
    addKey,
    updateKey,
    deleteKey,
    getKeyValue,
    loadKeys,
  } = useCustomKeys();

  const [searchQuery, setSearchQuery] = useState("");
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editPermission, setEditPermission] = useState<"always" | "ask">("ask");
  const [showEditValue, setShowEditValue] = useState(false);
  const [loadingEditValue, setLoadingEditValue] = useState(false);
  const [showAddKeyValue, setShowAddKeyValue] = useState(false);
  const [showAddKey, setShowAddKey] = useState(false);
  const [keyForm, setKeyForm] = useState<CustomKeyInput>({
    name: "",
    value: "",
    description: "",
    permission: "ask",
  });

  // Combine default keys with custom keys
  const allKeys: KeyDisplayItem[] = useMemo(() => {
    return [
      ...DEFAULT_KEYS.map((dk) => {
        const existing = customKeys.find((k) => k.name === dk.name);
        return {
          id: existing?.id || `default-${dk.name}`,
          name: dk.name,
          description: existing?.description || dk.description,
          hint: dk.hint,
          hasValue: !!existing,
          isDefault: true,
          addedAt: existing?.createdAt,
          permission: (existing?.permission as "always" | "ask") || "always",
          source: existing?.source,
          managedBy: existing?.managedBy,
          oauthProvider: existing?.oauthProvider,
        };
      }),
      ...customKeys
        .filter((k) => !DEFAULT_KEYS.some((dk) => dk.name === k.name))
        .map((k) => ({
          id: k.id,
          name: k.name,
          description: k.description,
          hint: "",
          hasValue: true,
          isDefault: false,
          addedAt: k.createdAt,
          permission: k.permission as "always" | "ask",
          source: k.source,
          managedBy: k.managedBy,
          oauthProvider: k.oauthProvider,
        })),
    ];
  }, [customKeys]);

  const filteredKeys = allKeys.filter((k) =>
    k.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const handleStartEdit = async (keyItem: KeyDisplayItem) => {
    setEditingKeyId(keyItem.id);
    setEditPermission(keyItem.permission);
    setShowEditValue(false);
    setEditValue("");
    if (keyItem.hasValue && !keyItem.id.startsWith("default-")) {
      setLoadingEditValue(true);
      try {
        const value = await getKeyValue(keyItem.id);
        setEditValue(value ?? "");
      } catch {
        setEditValue("");
      } finally {
        setLoadingEditValue(false);
      }
    }
  };

  const handleSaveKey = async (keyItem: KeyDisplayItem) => {
    const isUpdate = keyItem.hasValue && !keyItem.id.startsWith("default-");
    const valueToSave = editValue.trim();

    if (!isUpdate && !valueToSave) {
      alert("Please enter a value for the key");
      return;
    }

    try {
      if (isUpdate) {
        const updates: Partial<CustomKeyInput> = {
          name: keyItem.name,
          description: keyItem.description,
          permission: editPermission,
        };
        if (valueToSave) updates.value = valueToSave;
        await updateKey(keyItem.id, updates);
      } else {
        await addKey({
          name: keyItem.name,
          value: valueToSave,
          description: keyItem.description,
          permission: editPermission,
        });
      }
      setEditingKeyId(null);
      setEditValue("");
      setShowEditValue(false);
      setEditPermission("ask");
    } catch (err) {
      console.error("Error saving key:", err);
      alert("Failed to save key. Please try again.");
    }
  };

  const handleDeleteKey = async (keyItem: KeyDisplayItem) => {
    if (!keyItem.hasValue) return;

    if (confirm(`Are you sure you want to delete ${keyItem.name}?`)) {
      await deleteKey(keyItem.id);
    }
  };

  const handleAddCustomKey = async () => {
    if (!keyForm.name || !keyForm.value) {
      alert("Please enter both key name and value");
      return;
    }

    const success = await addKey(keyForm);
    if (success) {
      setShowAddKey(false);
      setKeyForm({ name: "", value: "", description: "", permission: "ask" });
      setShowAddKeyValue(false);
    }
  };

  const formatDate = (date?: string) => {
    if (!date) return "";
    const d = new Date(date);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div className="settings-content settings-content--full-width">
      {/* Papr Login Section - Automatic API Key Provisioning */}
      <div className="settings-section">
        <PaprLoginSection onApiKeyReceived={() => loadKeys()} />
      </div>

      {/* OAuth Section - Connect to Subscriptions */}
      <div className="settings-section">
        <h2 className="settings-section__title">Connect Your Accounts</h2>
        <p className="settings-section__description">
          Sign in with OpenAI or Claude to use your subscription
        </p>
        
        <div className="oauth-grid">
          <OAuthSection
            provider="openai"
            title="OpenAI"
            subscriptionName="ChatGPT Plus/Pro"
            apiKeyName="OPENAI_API_KEY"
            apiKeyHint="platform.openai.com/api-keys"
          />

          <OAuthSection
            provider="anthropic"
            title="Claude"
            subscriptionName="Claude Pro/Max"
            apiKeyName="ANTHROPIC_API_KEY"
            apiKeyHint="console.anthropic.com"
          />
        </div>
      </div>

      {/* API Keys Section */}
      <div className="settings-section">
        <div className="api-keys-header">
          <div>
            <h2 className="settings-section__title">API Keys</h2>
            <p className="settings-section__description">
              Store API keys, tokens, and config securely. Encrypted using your
              system's secure storage.
            </p>
          </div>
          <button
            className="settings-btn settings-btn--primary"
            onClick={() => setShowAddKey(!showAddKey)}
          >
            {showAddKey ? "Cancel" : "Add API Key"}
          </button>
        </div>

        {error && <div className="custom-keys-error">{error}</div>}

        {showAddKey && (
          <div className="custom-key-form" style={{ marginBottom: "24px" }}>
            <div className="form-group">
              <label className="form-label">Key Name</label>
              <input
                type="text"
                className="form-input"
                placeholder="MY_CUSTOM_KEY"
                value={keyForm.name}
                onChange={(e) =>
                  setKeyForm({
                    ...keyForm,
                    name: e.target.value
                      .toUpperCase()
                      .replace(/[^A-Z0-9_]/g, "_"),
                  })
                }
              />
            </div>

            <div className="form-group">
              <label className="form-label">Key Value</label>
              <div className="api-key-input-wrapper">
                <input
                  type={showAddKeyValue ? "text" : "password"}
                  className="form-input"
                  placeholder="Enter the API key value"
                  value={keyForm.value}
                  onChange={(e) =>
                    setKeyForm({ ...keyForm, value: e.target.value })
                  }
                />
                <button
                  className="api-key-visibility-btn"
                  onClick={() => setShowAddKeyValue(!showAddKeyValue)}
                  title={showAddKeyValue ? "Hide value" : "Show value"}
                  type="button"
                >
                  {showAddKeyValue ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Description (Optional)</label>
              <input
                type="text"
                className="form-input"
                placeholder="What is this key for?"
                value={keyForm.description}
                onChange={(e) =>
                  setKeyForm({ ...keyForm, description: e.target.value })
                }
              />
            </div>

            <div className="form-group">
              <label className="form-label">Permission</label>
              <div className="key-permission-selector">
                <label className="key-permission-option">
                  <input
                    type="radio"
                    name="add-key-permission"
                    checked={keyForm.permission === "always"}
                    onChange={() =>
                      setKeyForm({ ...keyForm, permission: "always" })
                    }
                  />
                  <div className="key-permission-card">
                    <span className="key-permission-title">Always allow</span>
                    <span className="key-permission-desc">
                      Auto-substitutes in jobs and tools. No prompts.
                    </span>
                  </div>
                </label>
                <label className="key-permission-option">
                  <input
                    type="radio"
                    name="add-key-permission"
                    checked={keyForm.permission === "ask"}
                    onChange={() =>
                      setKeyForm({ ...keyForm, permission: "ask" })
                    }
                  />
                  <div className="key-permission-card">
                    <span className="key-permission-title">Ask each time</span>
                    <span className="key-permission-desc">
                      Prompts before each use. More secure for sensitive keys.
                    </span>
                  </div>
                </label>
              </div>
            </div>

            <div className="custom-key-form-actions">
              <button
                className="settings-btn settings-btn--secondary"
                onClick={() => {
                  setShowAddKey(false);
                  setShowAddKeyValue(false);
                }}
              >
                Cancel
              </button>
              <button
                className="settings-btn settings-btn--primary"
                onClick={handleAddCustomKey}
              >
                Save Key
              </button>
            </div>
          </div>
        )}

        {/* Search */}
        <div className="api-keys-search">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Keys List */}
        {loading ? (
          <div className="custom-keys-loading">Loading keys...</div>
        ) : (
          <div className="api-keys-list">
            {filteredKeys.map((keyItem) => (
              <div
                key={keyItem.id}
                className={`api-key-row ${editingKeyId === keyItem.id ? "api-key-row--editing" : ""}`}
              >
                {editingKeyId === keyItem.id ? (
                  // Edit mode - vertical layout
                  <>
                    <div className="api-key-row-content">
                      <div className="api-key-info">
                        <div className="api-key-name">{keyItem.name}</div>
                        <div className="api-key-hint">{keyItem.hint}</div>
                      </div>
                    </div>
                    <div className="api-key-edit-section">
                      <div className="api-key-input-wrapper">
                        <input
                          type={showEditValue ? "text" : "password"}
                          className="form-input"
                          placeholder={
                            keyItem.hasValue
                              ? "Leave blank to keep current value"
                              : "Enter value"
                          }
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          autoFocus
                          disabled={loadingEditValue}
                        />
                        {loadingEditValue ? (
                          <span className="api-key-loading">Loading…</span>
                        ) : (
                          <button
                            className="api-key-visibility-btn"
                            onClick={() => setShowEditValue(!showEditValue)}
                            title={showEditValue ? "Hide value" : "Show value"}
                            type="button"
                          >
                            {showEditValue ? (
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                <line x1="1" y1="1" x2="23" y2="23" />
                              </svg>
                            ) : (
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                              </svg>
                            )}
                          </button>
                        )}
                      </div>
                      <div className="form-group form-group--compact">
                        <label className="form-label">Permission</label>
                        <div className="key-permission-selector">
                          <label className="key-permission-option">
                            <input
                              type="radio"
                              name={`edit-permission-${keyItem.id}`}
                              checked={editPermission === "always"}
                              onChange={() => setEditPermission("always")}
                            />
                            <div className="key-permission-card">
                              <span className="key-permission-title">
                                Always allow
                              </span>
                              <span className="key-permission-desc">
                                Auto-substitutes. No prompts.
                              </span>
                            </div>
                          </label>
                          <label className="key-permission-option">
                            <input
                              type="radio"
                              name={`edit-permission-${keyItem.id}`}
                              checked={editPermission === "ask"}
                              onChange={() => setEditPermission("ask")}
                            />
                            <div className="key-permission-card">
                              <span className="key-permission-title">
                                Ask each time
                              </span>
                              <span className="key-permission-desc">
                                Prompts before use. More secure.
                              </span>
                            </div>
                          </label>
                        </div>
                      </div>
                      <div className="api-key-actions">
                        <button
                          className="settings-btn settings-btn--secondary"
                          onClick={() => {
                            setEditingKeyId(null);
                            setEditValue("");
                            setShowEditValue(false);
                            setEditPermission("ask");
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          className="settings-btn settings-btn--primary"
                          onClick={() => handleSaveKey(keyItem)}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  // View mode
                  <>
                    <div className="api-key-info">
                      <div className="api-key-name">
                        {keyItem.name}
                        {keyItem.source === "oauth" && (
                          <span className="oauth-badge">🔒 OAuth</span>
                        )}
                      </div>
                      <div className="api-key-hint">{keyItem.hint}</div>
                    </div>
                    <div className="api-key-value">
                      {keyItem.hasValue ? (
                        <>
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <circle cx="12" cy="12" r="1" />
                            <circle cx="19" cy="12" r="1" />
                            <circle cx="5" cy="12" r="1" />
                          </svg>
                          <span>••••••••••••</span>
                        </>
                      ) : (
                        <span className="api-key-not-set">Not set</span>
                      )}
                    </div>
                    <div className="api-key-added">
                      {keyItem.addedAt
                        ? `Added ${formatDate(keyItem.addedAt)}`
                        : ""}
                    </div>
                    <div className="api-key-actions">
                      <button
                        className="api-key-action-btn"
                        onClick={() => handleStartEdit(keyItem)}
                        title="Edit"
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                      {!keyItem.isDefault && keyItem.hasValue && (
                        <button
                          className="api-key-action-btn"
                          onClick={() => handleDeleteKey(keyItem)}
                          title="Delete"
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
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
    if (!telemetryApi) {
      setLoaded(true);
      return;
    }
    void telemetryApi
      .getEnabled()
      .then((r) => {
        setTelemetryEnabled(r.enabled);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [telemetryApi]);

  const handleTelemetryChange = async (next: boolean) => {
    if (!telemetryApi) return;
    setSaving(true);
    try {
      const result = await telemetryApi.setEnabled(next);
      if (result.success) {
        setTelemetryEnabled(result.enabled);
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
        <h2 className="settings-section__title">Privacy</h2>
        <p className="settings-section__description">
          Anonymous usage data helps us understand how Paprwork is used. In the
          downloaded app, this is on by default; developer/source builds default
          off. We never send chat content, prompts, file paths, or API keys.
          Events go to Papr&apos;s telemetry proxy only; see the README for
          details and environment overrides.
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
              <h4>Anonymous usage statistics</h4>
            </div>
            <p>
              Send coarse events (for example app opened) to help improve the
              product. You can turn this off anytime.
            </p>
          </div>
        </label>
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

// ===== Memory Tab =====

function MemoryTab() {
  const { status, loading, error } = useCodeIndexing();
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);

  // Load workspace files on mount
  useEffect(() => {
    loadWorkspaceFiles();
  }, []);

  const loadWorkspaceFiles = async () => {
    try {
      const response = await gateway.send("memory:list-workspace-files", {});
      if (response.success && response.data) {
        setWorkspaceFiles((response.data as { files: string[] }).files);
      }
    } catch (err) {
      console.error("Failed to load workspace files:", err);
    }
  };

  const openFolder = async (folderPath: string) => {
    try {
      await gateway.send("memory:open-folder", { folderPath });
    } catch (err) {
      console.error("Failed to open folder:", err);
      alert(`Failed to open folder: ${folderPath}`);
    }
  };

  return (
    <div className="settings-content settings-content--full-width">
      <div className="settings-section">
        <h2 className="settings-section__title">Memory</h2>

        {/* Top Grid: Workspace Context (left) + PAPR Folder (right) */}
        <div className="memory-grid-top">
          {/* Workspace Context */}
          <div className="data-card">
            <div className="data-card__header">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
              <div className="data-card__title-group">
                <h3>Workspace Context</h3>
                <p>Context files for AI agents</p>
              </div>
              <button
                className="settings-btn settings-btn--primary"
                onClick={() => openFolder("~/Papr/workspace/")}
              >
                Open Folder
              </button>
            </div>

            <div className="workspace-files">
              {workspaceFiles.length > 0 ? (
                workspaceFiles.map((file) => (
                  <div key={file} className="workspace-file-item">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span>{file}</span>
                  </div>
                ))
              ) : (
                <div className="workspace-file-item">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span>No files yet</span>
                </div>
              )}
            </div>
          </div>

          {/* PAPR Folder */}
          <div className="data-card">
            <div className="data-card__header">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <div className="data-card__title-group">
                <h3>PAPR Folder</h3>
                <p>
                  <code>~/Papr/</code> - chats, apps, jobs, workspace
                </p>
              </div>
              <button
                className="settings-btn settings-btn--primary"
                onClick={() => openFolder("~/Papr/")}
              >
                Open Folder
              </button>
            </div>

            <div className="folder-structure">
              <div className="folder-item">
                <span className="folder-icon">📁</span>
                <span className="folder-name">apps/</span>
                <span className="folder-desc">Mini-apps</span>
              </div>
              <div className="folder-item">
                <span className="folder-icon">📁</span>
                <span className="folder-name">Jobs/</span>
                <span className="folder-desc">Automated jobs</span>
              </div>
              <div className="folder-item">
                <span className="folder-icon">📁</span>
                <span className="folder-name">workspace/</span>
                <span className="folder-desc">Context files</span>
              </div>
              <div className="folder-item">
                <span className="folder-icon">📄</span>
                <span className="folder-name">chats.db</span>
                <span className="folder-desc">Chat history</span>
              </div>
            </div>
          </div>
        </div>

        {/* Memory Indexing - Wide card with 3 columns */}
        <div className="data-card">
          <div className="data-card__header">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
            <div>
              <h3>Memory Indexing</h3>
              <p>
                Automatic indexing to PAPR Memory Cloud for semantic search
              </p>
            </div>
            {status && (
              <div className="memory-status-badge">
                {status.enabled ? (
                  <span className="status-badge status-badge--active">
                    ✓ Active
                  </span>
                ) : (
                  <span className="status-badge status-badge--inactive">
                    Inactive
                  </span>
                )}
              </div>
            )}
          </div>

          {loading && (
            <div className="memory-loading">Loading status...</div>
          )}

          {error && (
            <div className="memory-error">Failed to load status: {error}</div>
          )}

          {status && (
            <div className="memory-grid-categories">
              {/* Chat Memories */}
              <div className="memory-category">
                <div className="memory-category-header">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <h4>Chat</h4>
                </div>
                <div className="memory-stats">
                  <div className="stat-item">
                    <span className="stat-label">Conversations</span>
                    <span className="stat-value">
                      {status.chat_stats?.total_chats ?? 0}
                    </span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">Messages</span>
                    <span className="stat-value">
                      {status.chat_stats?.total_messages ?? 0}
                    </span>
                  </div>
                  <div className="stat-item stat-item--full">
                    <span className="stat-label">Last Indexed</span>
                    <span className="stat-value">
                      {status.chat_stats?.last_indexed
                        ? new Date(status.chat_stats.last_indexed).toLocaleString()
                        : 'Not available'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Code Memories */}
              <div className="memory-category">
                <div className="memory-category-header">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                  </svg>
                  <h4>Code</h4>
                  {status.status?.is_indexing && (
                    <div className="indexing-indicator">
                      <div className="spinner" />
                      <span>Indexing...</span>
                    </div>
                  )}
                </div>
                <div className="memory-stats">
                  <div className="stat-item">
                    <span className="stat-label">Mini-apps</span>
                    <span className="stat-value">
                      {Math.floor((status.status?.stats.total_projects ?? 0) / 2)} apps
                    </span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">Jobs</span>
                    <span className="stat-value">
                      {Math.ceil((status.status?.stats.total_projects ?? 0) / 2)} jobs
                    </span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">Total Files</span>
                    <span className="stat-value">
                      {status.status?.stats.total_files ?? 0}
                    </span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">Queue</span>
                    <span className="stat-value">
                      {status.status?.stats.queue_size ?? 0}
                    </span>
                  </div>
                  {status.status?.stats.last_indexed_at && (
                    <div className="stat-item stat-item--full">
                      <span className="stat-label">Last Indexed</span>
                      <span className="stat-value">
                        {new Date(
                          status.status.stats.last_indexed_at
                        ).toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Document Memories */}
              <div className="memory-category memory-category--disabled">
                <div className="memory-category-header">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                  <h4>Documents</h4>
                  <span className="coming-soon-badge">Coming soon</span>
                </div>
                <div className="memory-stats">
                  <div className="stat-item stat-item--full">
                    <span className="stat-value coming-soon-text">
                      Document indexing available in a future update
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
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
            hours
          </p>
        </div>

        {/* License & Credits */}
        <div className="about-card">
          <h3>License & Credits</h3>
          <p className="about-license-text">
            Paprwork V2 is open source software licensed under AGPL-3.0
          </p>
          <p className="about-license-text">
            Built with Electron, TypeScript, React, and Mastra
          </p>
          <p className="about-license-text">
            © 2024-2026 Amir Kabbara. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
}
