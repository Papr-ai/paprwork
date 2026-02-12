/**
 * SettingsView - Settings page with tabs for API Keys, Profile, and Permissions
 * Reference: Paprwork v1 settings modal
 */

import React, { useState, useEffect, useMemo } from "react";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import type { CustomKeyInput, SettingsTab } from "../../types/settings";
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
      </div>

      {/* Content */}
      <div className="settings-view__content">
        {activeTab === "keys" && <APIKeysTab />}
        {activeTab === "profile" && <ProfileTab />}
        {activeTab === "permissions" && <PermissionsTab />}
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
}

function APIKeysTab() {
  const {
    keys: customKeys,
    loading,
    error,
    addKey,
    updateKey,
    deleteKey,
  } = useCustomKeys();

  const [searchQuery, setSearchQuery] = useState("");
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showEditValue, setShowEditValue] = useState(false);
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
        })),
    ];
  }, [customKeys]);

  const filteredKeys = allKeys.filter((k) =>
    k.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleStartEdit = (keyItem: KeyDisplayItem) => {
    setEditingKeyId(keyItem.id);
    setEditValue("");
    setShowEditValue(false);
  };

  const handleSaveKey = async (keyItem: KeyDisplayItem) => {
    if (!editValue.trim()) {
      alert("Please enter a value for the key");
      return;
    }

    try {
      if (keyItem.hasValue) {
        // Update existing
        await updateKey(keyItem.id, {
          name: keyItem.name,
          value: editValue,
          description: keyItem.description,
          permission: keyItem.permission,
        });
      } else {
        // Add new
        await addKey({
          name: keyItem.name,
          value: editValue,
          description: keyItem.description,
          permission: keyItem.permission,
        });
      }
      setEditingKeyId(null);
      setEditValue("");
      setShowEditValue(false);
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
    }
  };

  const formatDate = (date?: string) => {
    if (!date) return "";
    const d = new Date(date);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div className="settings-content">
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
              <input
                type="password"
                className="form-input"
                placeholder="Enter the API key value"
                value={keyForm.value}
                onChange={(e) =>
                  setKeyForm({ ...keyForm, value: e.target.value })
                }
              />
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

            <div className="custom-key-form-actions">
              <button
                className="settings-btn settings-btn--secondary"
                onClick={() => setShowAddKey(false)}
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
                          placeholder="Enter new value"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          autoFocus
                        />
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
                      </div>
                      <div className="api-key-actions">
                        <button
                          className="settings-btn settings-btn--secondary"
                          onClick={() => {
                            setEditingKeyId(null);
                            setEditValue("");
                            setShowEditValue(false);
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
                      <div className="api-key-name">{keyItem.name}</div>
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
                      {keyItem.addedAt ? `Added ${formatDate(keyItem.addedAt)}` : ""}
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
  return (
    <div className="settings-content">
      <div className="settings-section">
        <h2 className="settings-section__title">Your Profile</h2>
        <p className="settings-section__description">
          This information helps personalize your experience
        </p>

        <div className="form-group">
          <label className="form-label">Name</label>
          <input type="text" className="form-input" placeholder="Your name" />
        </div>

        <div className="form-group">
          <label className="form-label">
            Email <span className="form-label__optional">(optional)</span>
          </label>
          <input
            type="email"
            className="form-input"
            placeholder="your@email.com"
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
          />
        </div>
      </div>

      <div className="settings-actions">
        <button className="settings-btn settings-btn--primary">
          Save Profile
        </button>
      </div>
    </div>
  );
}

function PermissionsTab() {
  return (
    <div className="settings-content">
      <div className="settings-section">
        <h2 className="settings-section__title">Permissions</h2>
        <p className="settings-section__description">
          Control what agents and automations can access
        </p>

        <div className="permission-group">
          <div className="permission-group__header">
            <h3>File System</h3>
            <p>Allow reading and writing files</p>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" defaultChecked />
            <span className="toggle-switch__slider"></span>
          </label>
        </div>

        <div className="permission-group">
          <div className="permission-group__header">
            <h3>Network</h3>
            <p>Allow making HTTP requests</p>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" defaultChecked />
            <span className="toggle-switch__slider"></span>
          </label>
        </div>

        <div className="permission-group">
          <div className="permission-group__header">
            <h3>Calendar</h3>
            <p>Allow reading and creating calendar events</p>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" />
            <span className="toggle-switch__slider"></span>
          </label>
        </div>
      </div>

      <div className="settings-actions">
        <button className="settings-btn settings-btn--primary">
          Save Permissions
        </button>
      </div>
    </div>
  );
}
