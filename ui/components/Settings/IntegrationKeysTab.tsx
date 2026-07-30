/**
 * IntegrationKeysTab - Non-AI API keys for jobs, automations, and integrations
 */

import React, { useEffect, useMemo, useState } from "react";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import type { CustomKey, CustomKeyInput } from "../../types/settings";
import { PaprLoginSection } from "./PaprLoginSection";
import { OrgKeysVaultBanner } from "./OrgKeysVaultBanner";
import {
  IntegrationKeyOrgScopeSelector,
  type IntegrationKeyOrgScopeValue,
  type OrgScopeOption,
  formatOrgScopeLabel,
  orgScopeValueFromKey,
  toOrgScopeInput,
} from "./IntegrationKeyOrgScopeSelector";
import {
  IntegrationKeyVaultAudienceSelector,
  formatVaultAudienceLabel,
} from "./IntegrationKeyVaultAudienceSelector";
import type { IntegrationKeyVaultAudience } from "../../constants/integrationKeyVaultAudience";
import {
  IntegrationKeyOptionsRow,
  IntegrationKeySelectField,
  INTEGRATION_KEY_CLIENT_ACCESS_OPTIONS,
  INTEGRATION_KEY_CLIENT_ACCESS_INFO,
  INTEGRATION_KEY_PERMISSION_OPTIONS,
  INTEGRATION_KEY_PERMISSION_INFO,
} from "./IntegrationKeyOptionsRow";
import "./IntegrationKeyOrgScopeSelector.css";
import "./IntegrationKeyVaultAudienceSelector.css";
import "./IntegrationKeyOptionsRow.css";

const AI_KEY_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "PAPR_API_KEY",
];

type KeyDisplayItem = CustomKey & {
  hasValue: boolean;
  addedAt?: string;
};

function defaultOrgScopeValue(
  _organizationId?: string | null,
): IntegrationKeyOrgScopeValue {
  return { mode: "all" };
}

export function IntegrationKeysTab() {
  const { keys, vaultContext, loading, addKey, updateKey, deleteKey, getKeyValue } =
    useCustomKeys();
  const [searchQuery, setSearchQuery] = useState("");
  const [organizations, setOrganizations] = useState<OrgScopeOption[]>([]);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editPermission, setEditPermission] = useState<"always" | "ask">("ask");
  const [editClientAccess, setEditClientAccess] = useState<"server" | "client">("server");
  const [editOrgScope, setEditOrgScope] = useState<IntegrationKeyOrgScopeValue>(
    defaultOrgScopeValue(vaultContext?.organizationId),
  );
  const [showEditValue, setShowEditValue] = useState(false);
  const [loadingEditValue, setLoadingEditValue] = useState(false);
  const [showAddKey, setShowAddKey] = useState(false);
  const [showAddKeyValue, setShowAddKeyValue] = useState(false);
  const [addOrgScope, setAddOrgScope] = useState<IntegrationKeyOrgScopeValue>(
    defaultOrgScopeValue(vaultContext?.organizationId),
  );
  const [addVaultAudience, setAddVaultAudience] =
    useState<IntegrationKeyVaultAudience>("user");
  const [editVaultAudience, setEditVaultAudience] =
    useState<IntegrationKeyVaultAudience>("user");
  const [keyForm, setKeyForm] = useState<CustomKeyInput>({
    name: "",
    value: "",
    description: "",
    permission: "ask",
    clientAccess: "server",
  });

  useEffect(() => {
    setAddOrgScope(defaultOrgScopeValue(vaultContext?.organizationId));
  }, [vaultContext?.organizationId]);

  useEffect(() => {
    void (async () => {
      if (!window.electronAPI?.papr?.listOrganizations) {
        return;
      }
      const result = await window.electronAPI.papr.listOrganizations();
      if (!result.success || !result.organizations) {
        return;
      }
      const options = result.organizations
        .filter((org) => org.organizationId)
        .map((org) => ({
          organizationId: org.organizationId!,
          label: org.workspaceName ?? org.name,
        }));
      setOrganizations(options);
    })();
  }, []);

  const integrationKeys: KeyDisplayItem[] = useMemo(() => {
    return keys
      .filter((key) => !AI_KEY_NAMES.includes(key.name))
      .map((key) => ({
        ...key,
        hasValue: true,
        addedAt: key.createdAt,
      }));
  }, [keys]);

  const filteredKeys = integrationKeys.filter((key) =>
    key.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const scopeLabelForKey = (key: CustomKey) =>
    formatOrgScopeLabel({
      orgScope: key.orgScope,
      organizationId: key.organizationId,
      activeOrganizationId: vaultContext?.organizationId,
      organizations,
      currentOrganizationLabel: vaultContext?.workspaceName,
    });

  const handleStartEdit = async (keyItem: KeyDisplayItem) => {
    setEditingKeyId(keyItem.id);
    setEditPermission(keyItem.permission);
    setEditClientAccess((keyItem.clientAccess ?? "server") as "server" | "client");
    setEditOrgScope(
      orgScopeValueFromKey({
        orgScope: keyItem.orgScope,
        organizationId: keyItem.organizationId,
        activeOrganizationId: vaultContext?.organizationId,
      }),
    );
    setEditVaultAudience(keyItem.vaultAudience ?? "user");
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
      const scopeInput = toOrgScopeInput(editOrgScope);
      const updates: Partial<CustomKeyInput> = {
        name: keyItem.name,
        description: keyItem.description,
        permission: editPermission,
        clientAccess: editClientAccess,
        vaultAudience: editVaultAudience,
        ...scopeInput,
      };
      if (valueToSave) {
        updates.value = valueToSave;
      } else if (
        keyItem.orgScope !== scopeInput.orgScope ||
        keyItem.organizationId !== scopeInput.organizationId ||
        (keyItem.vaultAudience ?? "user") !== editVaultAudience
      ) {
        updates.value = (await getKeyValue(keyItem.id)) ?? "";
      }
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
    const success = await addKey({
      ...keyForm,
      vaultAudience: addVaultAudience,
      ...toOrgScopeInput(addOrgScope),
    });
    if (success) {
      setShowAddKey(false);
      setKeyForm({
        name: "",
        value: "",
        description: "",
        permission: "ask",
        clientAccess: "server",
      });
      setAddOrgScope(defaultOrgScopeValue(vaultContext?.organizationId));
      setAddVaultAudience("user");
      setShowAddKeyValue(false);
    }
  };

  const formatDate = (date?: string) => {
    if (!date) return "";
    return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div className="settings-content settings-content--full-width">
      <div className="settings-section" style={{ marginBottom: "24px" }}>
        <PaprLoginSection onApiKeyReceived={() => undefined} />
      </div>

      <div className="settings-section">
        <OrgKeysVaultBanner
          vaultContext={vaultContext}
          workspaceName={vaultContext?.workspaceName}
          namespaceName={vaultContext?.namespaceName}
        />
        <div className="settings-section__header">
          <div>
            <h2 className="settings-section__title">Integration Keys</h2>
            <p className="settings-section__description">
              API keys for jobs, automations, and third-party services.
              Choose organization scope and who can use each key (only you, team, or organization).
            </p>
          </div>
          <button
            className="settings-btn settings-btn--primary"
            onClick={() => setShowAddKey(true)}
          >
            + Add Key
          </button>
        </div>

        {integrationKeys.length > 3 && (
          <div className="key-search">
            <input
              type="text"
              className="form-input"
              placeholder="Search keys..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
        )}

        {showAddKey && (
          <div className="key-add-form">
            <IntegrationKeyOptionsRow>
              <IntegrationKeyOrgScopeSelector
                compact
                idPrefix="add-org-scope"
                value={addOrgScope}
                onChange={setAddOrgScope}
                currentOrganizationId={vaultContext?.organizationId}
                currentOrganizationLabel={vaultContext?.workspaceName}
                organizations={organizations}
              />
              <IntegrationKeyVaultAudienceSelector
                compact
                idPrefix="add-vault-audience"
                value={addVaultAudience}
                onChange={setAddVaultAudience}
              />
              <IntegrationKeySelectField
                id="integration-key-add-permission"
                label="Permission"
                info={INTEGRATION_KEY_PERMISSION_INFO}
                value={keyForm.permission ?? "ask"}
                options={[...INTEGRATION_KEY_PERMISSION_OPTIONS]}
                onChange={(value) =>
                  setKeyForm((prev) => ({
                    ...prev,
                    permission: value as "always" | "ask",
                  }))
                }
              />
              <IntegrationKeySelectField
                id="integration-key-add-client-access"
                label="Browser access"
                info={INTEGRATION_KEY_CLIENT_ACCESS_INFO}
                value={keyForm.clientAccess ?? "server"}
                options={[...INTEGRATION_KEY_CLIENT_ACCESS_OPTIONS]}
                onChange={(value) =>
                  setKeyForm((prev) => ({
                    ...prev,
                    clientAccess: value as "server" | "client",
                  }))
                }
              />
            </IntegrationKeyOptionsRow>
            <div className="form-group">
              <label className="form-label">Key Name</label>
              <input
                type="text"
                className="form-input"
                placeholder="e.g., STRIPE_API_KEY"
                value={keyForm.name}
                onChange={(event) =>
                  setKeyForm((prev) => ({
                    ...prev,
                    name: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""),
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
                onChange={(event) =>
                  setKeyForm((prev) => ({ ...prev, description: event.target.value }))
                }
              />
            </div>
            <div className="form-group">
              <label className="form-label">Value</label>
              <input
                type={showAddKeyValue ? "text" : "password"}
                className="form-input"
                placeholder="Paste your API key"
                value={keyForm.value}
                onChange={(event) =>
                  setKeyForm((prev) => ({ ...prev, value: event.target.value }))
                }
              />
              <button
                className="settings-btn settings-btn--small"
                style={{ marginTop: 4 }}
                onClick={() => setShowAddKeyValue(!showAddKeyValue)}
              >
                {showAddKeyValue ? "Hide" : "Show"}
              </button>
            </div>
            <div className="key-add-form__actions">
              <button
                className="settings-btn settings-btn--secondary"
                onClick={() => setShowAddKey(false)}
              >
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

        {loading ? (
          <p className="settings-loading">Loading keys...</p>
        ) : filteredKeys.length === 0 ? (
          <div className="key-empty">
            <p>No integration keys configured for this vault yet.</p>
            <p className="key-empty__hint">
              Add organization-only keys here, or choose &quot;All organizations&quot; for shared keys like a team Stripe account.
            </p>
          </div>
        ) : (
          <div className="key-list">
            {filteredKeys.map((keyItem) => (
              <div key={keyItem.id} className="key-item">
                {editingKeyId === keyItem.id ? (
                  <div className="key-item__edit">
                    <div className="key-item__edit-header">
                      <span className="key-item__name">{keyItem.name}</span>
                    </div>
                    <IntegrationKeyOptionsRow>
                      <IntegrationKeyOrgScopeSelector
                        compact
                        idPrefix={`edit-org-scope-${keyItem.id}`}
                        value={editOrgScope}
                        onChange={setEditOrgScope}
                        currentOrganizationId={vaultContext?.organizationId}
                        currentOrganizationLabel={vaultContext?.workspaceName}
                        organizations={organizations}
                      />
                      <IntegrationKeyVaultAudienceSelector
                        compact
                        idPrefix={`edit-vault-audience-${keyItem.id}`}
                        value={editVaultAudience}
                        onChange={setEditVaultAudience}
                      />
                      <IntegrationKeySelectField
                        id={`integration-key-edit-permission-${keyItem.id}`}
                        label="Permission"
                        info={INTEGRATION_KEY_PERMISSION_INFO}
                        value={editPermission}
                        options={[...INTEGRATION_KEY_PERMISSION_OPTIONS]}
                        onChange={(value) =>
                          setEditPermission(value as "always" | "ask")
                        }
                      />
                      <IntegrationKeySelectField
                        id={`integration-key-edit-client-access-${keyItem.id}`}
                        label="Browser access"
                        info={INTEGRATION_KEY_CLIENT_ACCESS_INFO}
                        value={editClientAccess}
                        options={[...INTEGRATION_KEY_CLIENT_ACCESS_OPTIONS]}
                        onChange={(value) =>
                          setEditClientAccess(value as "server" | "client")
                        }
                      />
                    </IntegrationKeyOptionsRow>
                    <div className="form-group">
                      <input
                        type={showEditValue ? "text" : "password"}
                        className="form-input"
                        placeholder="Enter new value (leave empty to keep current)"
                        value={editValue}
                        onChange={(event) => setEditValue(event.target.value)}
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
                  <div className="key-item__display">
                    <div className="key-item__info">
                      <span className="key-item__name">{keyItem.name}</span>
                      {keyItem.description && (
                        <span className="key-item__description">{keyItem.description}</span>
                      )}
                      {keyItem.addedAt && (
                        <span className="key-item__date">
                          Added {formatDate(keyItem.addedAt)}
                        </span>
                      )}
                    </div>
                    <div className="key-item__actions">
                      <span
                        className={`key-item__scope-badge ${
                          keyItem.orgScope === "all" ? "key-item__scope-badge--shared" : ""
                        }`}
                      >
                        {scopeLabelForKey(keyItem)}
                        {keyItem.vaultAudience && keyItem.vaultAudience !== "user"
                          ? ` · ${formatVaultAudienceLabel(keyItem.vaultAudience)}`
                          : ""}
                      </span>
                      <span
                        className={`key-item__permission key-item__permission--${keyItem.permission}`}
                      >
                        {keyItem.permission === "always" ? "Auto" : "Ask"}
                      </span>
                      {keyItem.clientAccess === "client" && (
                        <span className="key-item__permission key-item__permission--client">
                          Browser
                        </span>
                      )}
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
