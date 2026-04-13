/**
 * IntegrationKeysTab - Non-AI API keys for jobs, automations, and integrations
 * "I need to connect a service" — Stripe, Slack, Amplitude, custom keys
 */

import React, { useState, useMemo } from "react";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import type { CustomKeyInput } from "../../types/settings";
import { PaprLoginSection } from "./PaprLoginSection";

// AI keys live in AI Models tab — filter them out here
const AI_KEY_NAMES = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "PAPR_API_KEY"];

interface KeyDisplayItem {
  id: string;
  name: string;
  description?: string;
  hasValue: boolean;
  addedAt?: string;
  permission: "always" | "ask";
}

export function IntegrationKeysTab() {
  const { keys, loading, addKey, updateKey, deleteKey, getKeyValue } = useCustomKeys();
  const [searchQuery, setSearchQuery] = useState("");
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editPermission, setEditPermission] = useState<"always" | "ask">("ask");
  const [showEditValue, setShowEditValue] = useState(false);
  const [loadingEditValue, setLoadingEditValue] = useState(false);
  const [showAddKey, setShowAddKey] = useState(false);
  const [showAddKeyValue, setShowAddKeyValue] = useState(false);
  const [keyForm, setKeyForm] = useState<CustomKeyInput>({
    name: "",
    value: "",
    description: "",
    permission: "ask",
  });

  // Filter out AI keys — those are managed in AI Models tab
  const integrationKeys: KeyDisplayItem[] = useMemo(() => {
    return keys
      .filter(k => !AI_KEY_NAMES.includes(k.name))
      .map(k => ({
        id: k.id,
        name: k.name,
        description: k.description,
        hasValue: true,
        addedAt: k.createdAt,
        permission: k.permission as "always" | "ask",
      }));
  }, [keys]);

  const filteredKeys = integrationKeys.filter(k =>
    k.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const handleStartEdit = async (keyItem: KeyDisplayItem) => {
    setEditingKeyId(keyItem.id);
    setEditPermission(keyItem.permission);
    setShowEditValue(false);
    setEditValue("");
    setLoadingEditValue(true);
    try {
      const value = await getKeyValue(keyItem.id);
      setEditValue(value ?? "");
    } catch {
      setEditValue("");
    } finally {
      setLoadingEditValue(false);
    }
  };

  const handleSaveKey = async (keyItem: KeyDisplayItem) => {
    const valueToSave = editValue.trim();
    try {
      const updates: Partial<CustomKeyInput> = {
        name: keyItem.name,
        description: keyItem.description,
        permission: editPermission,
      };
      if (valueToSave) updates.value = valueToSave;
      await updateKey(keyItem.id, updates);
      setEditingKeyId(null);
      setEditValue("");
      setShowEditValue(false);
    } catch (err) {
      console.error("Error saving key:", err);
      alert("Failed to save key. Please try again.");
    }
  };

  const handleDeleteKey = async (keyItem: KeyDisplayItem) => {
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
    return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div className="settings-content settings-content--full-width">
      {/* Papr Login Section - Top of Integration Keys */}
      <div className="settings-section" style={{ marginBottom: "24px" }}>
        <PaprLoginSection onApiKeyReceived={() => {/* Keys auto-refresh */}} />
      </div>

      <div className="settings-section">
        <div className="settings-section__header">
          <div>
            <h2 className="settings-section__title">Integration Keys</h2>
            <p className="settings-section__description">
              API keys for jobs, automations, and third-party services.
              AI model keys are managed in the AI Models tab.
            </p>
          </div>
          <button
            className="settings-btn settings-btn--primary"
            onClick={() => setShowAddKey(true)}
          >
            + Add Key
          </button>
        </div>

        {/* Search */}
        {integrationKeys.length > 3 && (
          <div className="key-search">
            <input
              type="text"
              className="form-input"
              placeholder="Search keys..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        )}

        {/* Add Key Form */}
        {showAddKey && (
          <div className="key-add-form">
            <div className="form-group">
              <label className="form-label">Key Name</label>
              <input
                type="text"
                className="form-input"
                placeholder="e.g., STRIPE_API_KEY"
                value={keyForm.name}
                onChange={e =>
                  setKeyForm(prev => ({
                    ...prev,
                    name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""),
                  }))
                }
              />
            </div>
            <div className="form-group">
              <label className="form-label">
                Description <span className="form-label__optional">(optional)</span>
              </label>
              <input
                type="text"
                className="form-input"
                placeholder="What is this key for?"
                value={keyForm.description}
                onChange={e => setKeyForm(prev => ({ ...prev, description: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Value</label>
              <input
                type={showAddKeyValue ? "text" : "password"}
                className="form-input"
                placeholder="Paste your API key"
                value={keyForm.value}
                onChange={e => setKeyForm(prev => ({ ...prev, value: e.target.value }))}
              />
              <button
                className="settings-btn settings-btn--small"
                style={{ marginTop: 4 }}
                onClick={() => setShowAddKeyValue(!showAddKeyValue)}
              >
                {showAddKeyValue ? "Hide" : "Show"}
              </button>
            </div>
            <div className="form-group">
              <label className="form-label">Permission</label>
              <select
                className="form-input"
                value={keyForm.permission}
                onChange={e =>
                  setKeyForm(prev => ({ ...prev, permission: e.target.value as "always" | "ask" }))
                }
              >
                <option value="always">Always allow</option>
                <option value="ask">Ask each time</option>
              </select>
            </div>
            <div className="key-add-form__actions">
              <button className="settings-btn settings-btn--secondary" onClick={() => setShowAddKey(false)}>
                Cancel
              </button>
              <button
                className="settings-btn settings-btn--primary"
                onClick={handleAddCustomKey}
                disabled={!keyForm.name || !keyForm.value}
              >
                Save Key
              </button>
            </div>
          </div>
        )}

        {/* Key List */}
        {loading ? (
          <p className="settings-loading">Loading keys...</p>
        ) : filteredKeys.length === 0 ? (
          <div className="key-empty">
            <p>No integration keys configured yet.</p>
            <p className="key-empty__hint">
              Add API keys for services like Stripe, Slack, or any third-party API your jobs need.
            </p>
          </div>
        ) : (
          <div className="key-list">
            {filteredKeys.map(keyItem => (
              <div key={keyItem.id} className="key-item">
                {editingKeyId === keyItem.id ? (
                  /* Editing state */
                  <div className="key-item__edit">
                    <div className="key-item__edit-header">
                      <span className="key-item__name">{keyItem.name}</span>
                    </div>
                    <div className="form-group">
                      <input
                        type={showEditValue ? "text" : "password"}
                        className="form-input"
                        placeholder="Enter new value (leave empty to keep current)"
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        disabled={loadingEditValue}
                      />
                      <button
                        className="settings-btn settings-btn--small"
                        style={{ marginTop: 4 }}
                        onClick={() => setShowEditValue(!showEditValue)}
                      >
                        {showEditValue ? "Hide" : "Show"}
                      </button>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Permission</label>
                      <select
                        className="form-input"
                        value={editPermission}
                        onChange={e => setEditPermission(e.target.value as "always" | "ask")}
                      >
                        <option value="always">Always allow</option>
                        <option value="ask">Ask each time</option>
                      </select>
                    </div>
                    <div className="key-item__edit-actions">
                      <button
                        className="settings-btn settings-btn--secondary"
                        onClick={() => setEditingKeyId(null)}
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
                ) : (
                  /* Display state */
                  <div className="key-item__display">
                    <div className="key-item__info">
                      <span className="key-item__name">{keyItem.name}</span>
                      {keyItem.description && (
                        <span className="key-item__description">{keyItem.description}</span>
                      )}
                      {keyItem.addedAt && (
                        <span className="key-item__date">Added {formatDate(keyItem.addedAt)}</span>
                      )}
                    </div>
                    <div className="key-item__actions">
                      <span className={`key-item__permission key-item__permission--${keyItem.permission}`}>
                        {keyItem.permission === "always" ? "Auto" : "Ask"}
                      </span>
                      <button
                        className="settings-btn settings-btn--small"
                        onClick={() => handleStartEdit(keyItem)}
                      >
                        Edit
                      </button>
                      <button
                        className="settings-btn settings-btn--small settings-btn--danger"
                        onClick={() => handleDeleteKey(keyItem)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
