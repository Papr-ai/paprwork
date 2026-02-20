/**
 * SettingsView - Settings page with tabs for API Keys, Profile, and Permissions
 * Reference: Paprwork v1 settings modal
 */

import React, { useState, useEffect, useMemo } from "react";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import { gateway } from "../../src/lib/gateway";
import type { CustomKeyInput, SettingsTab } from "../../types/settings";
import { OAuthSection } from "./OAuthSection";
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
          className={`settings-tab ${activeTab === "data" ? "settings-tab--active" : ""}`}
          onClick={() => setActiveTab("data")}
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
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          </svg>
          Data
        </button>
      </div>

      {/* Content */}
      <div className="settings-view__content">
        {activeTab === "keys" && <APIKeysTab />}
        {activeTab === "profile" && <ProfileTab />}
        {activeTab === "permissions" && <PermissionsTab />}
        {activeTab === "data" && <DataTab />}
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
    <div className="settings-content">
      {/* OAuth Authentication Sections */}
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

      {/* API Keys Section */}
      <div className="settings-section">
        <div className="api-keys-header">
          <div>
            <h2 className="settings-section__title">API Keys</h2>
            <p className="settings-section__description">
              Store API keys, tokens, and config securely. Stored in macOS
              Keychain.
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

  // Load profile on mount
  useEffect(() => {
    (async () => {
      try {
        const response = await gateway.send("settings:get");
        const data = response.data as {
          profile?: { name?: string; email?: string; imageUrl?: string };
        };
        if (data?.profile) {
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
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await gateway.send("settings:save-profile", { name, email, imageUrl });
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
      <div className="settings-section">
        <h2 className="settings-section__title">Your Profile</h2>
        <p className="settings-section__description">
          This information helps personalize your experience
        </p>

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

        <div className="form-group">
          <label className="form-label">
            Profile Image URL{" "}
            <span className="form-label__optional">(optional)</span>
          </label>
          <input
            type="url"
            className="form-input"
            placeholder="https://..."
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
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
    <div className="settings-content">
      <div className="settings-section">
        <h2 className="settings-section__title">Agent Permissions</h2>
        <p className="settings-section__description">
          Control how much autonomy agents have
        </p>

        <div className="permission-level-selector">
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

// ===== Data & Migration Tab =====

interface MigrationResult {
  chats: { migrated: number; messages: number };
  documents: { migrated: number };
  apps: { migrated: number };
}

function DataTab() {
  const [migrating, setMigrating] = useState(false);
  const [migrationResult, setMigrationResult] =
    useState<MigrationResult | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);

  const handleMigrate = async () => {
    setMigrating(true);
    setMigrationResult(null);
    setMigrationError(null);

    try {
      const response = await gateway.send("settings:migrate-v1", {});
      if (response.success && response.data) {
        setMigrationResult(response.data as MigrationResult);
      } else {
        setMigrationError("Migration failed. Check the console for details.");
      }
    } catch (err) {
      setMigrationError((err as Error).message);
    } finally {
      setMigrating(false);
    }
  };

  return (
    <div className="settings-content">
      <div className="settings-section">
        <h2 className="settings-section__title">Data Management</h2>
        <p className="settings-section__description">
          Import data from Paprwork V1 or manage your stored data
        </p>

        {/* V1 Migration */}
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
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <div>
              <h3>Import from Paprwork V1</h3>
              <p>
                Migrate your chats, documents, and mini-apps from V1. This reads
                from <code>~/.paprwork/</code> and imports into the V2 data
                directory.
              </p>
            </div>
          </div>

          <button
            className="settings-btn settings-btn--primary"
            onClick={handleMigrate}
            disabled={migrating}
          >
            {migrating ? "Migrating..." : "Start Migration"}
          </button>

          {migrationResult && (
            <div className="migration-result">
              <h4>Migration Complete</h4>
              <ul>
                <li>
                  Chats: {migrationResult.chats.migrated} imported (
                  {migrationResult.chats.messages} messages)
                </li>
                <li>
                  Documents: {migrationResult.documents.migrated} imported
                </li>
                <li>Apps: {migrationResult.apps.migrated} imported</li>
              </ul>
            </div>
          )}

          {migrationError && (
            <div className="migration-error">Error: {migrationError}</div>
          )}
        </div>

        {/* Storage info */}
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
            <div>
              <h3>Data Location</h3>
              <p>
                Your V2 data is stored at <code>~/PAPR/</code>. This includes
                chats, documents, apps, settings, and meeting data.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
