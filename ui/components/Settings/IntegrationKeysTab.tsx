/**
 * IntegrationKeysTab - Non-AI API keys for jobs, automations, and integrations
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import type { CustomKey, CustomKeyInput } from "../../types/settings";
import type { IntegrationKeyVaultAudience } from "../../constants/integrationKeyVaultAudience";
import {
  pullSharedVaultKeys,
  syncVaultKeyChange,
} from "../../utils/vaultPullShared";
import {
  IntegrationKeyMemberPicker,
  type WorkspaceMemberOption,
} from "./IntegrationKeyMemberPicker";
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
import "./IntegrationKeyMemberPicker.css";
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
  const {
    keys,
    vaultContext,
    loading,
    loadKeys,
    addKey,
    updateKey,
    deleteKey,
    getKeyValue,
  } = useCustomKeys();
  const [searchQuery, setSearchQuery] = useState("");
  const [refreshingShared, setRefreshingShared] = useState(false);
  const sharedPullStarted = useRef(false);
  const [memberNameById, setMemberNameById] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMemberOption[]>(
    [],
  );
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [addMemberIds, setAddMemberIds] = useState<string[]>([]);
  const [editMemberIds, setEditMemberIds] = useState<string[]>([]);
  const [viewingKeyId, setViewingKeyId] = useState<string | null>(null);
  const [viewValue, setViewValue] = useState("");
  const [loadingViewValue, setLoadingViewValue] = useState(false);
  const [showViewValue, setShowViewValue] = useState(false);
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

  useEffect(() => {
    void (async () => {
      const profileResult = await window.electronAPI?.papr?.getProfile?.();
      const profileUserId = profileResult?.success
        ? profileResult.profile?.userId?.trim().toLowerCase() ?? null
        : null;
      setCurrentUserId(profileUserId);

      if (!window.electronAPI?.papr?.listWorkspaceMembers) {
        return;
      }
      const result = await window.electronAPI.papr.listWorkspaceMembers();
      if (!result.success || !result.members) {
        return;
      }
      const map = new Map<string, string>();
      const options: WorkspaceMemberOption[] = [];
      for (const member of result.members) {
        const userId = member.user.objectId?.trim();
        if (!userId) {
          continue;
        }
        const normalizedId = userId.toLowerCase();
        const displayName =
          member.user.displayName?.trim() ||
          member.user.email?.trim() ||
          userId;
        map.set(normalizedId, displayName);
        if (profileUserId && normalizedId === profileUserId) {
          continue;
        }
        options.push({
          userId,
          displayName,
          email: member.user.email,
          role: member.user.role,
        });
      }
      setMemberNameById(map);
      setWorkspaceMembers(options);
    })();
  }, [vaultContext?.organizationId]);

  useEffect(() => {
    if (sharedPullStarted.current) {
      return;
    }
    sharedPullStarted.current = true;
    void (async () => {
      setRefreshingShared(true);
      try {
        await pullSharedVaultKeys();
        await loadKeys({ force: true });
      } finally {
        setRefreshingShared(false);
      }
    })();
  }, [loadKeys]);

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

  const isSharedMirror = (key: CustomKey): boolean => key.vaultOrigin === "shared";

  const sharedOwnerLabel = (key: CustomKey): string | null => {
    const ownerId = key.sharedOwnerUserId?.trim().toLowerCase();
    if (!ownerId) {
      return null;
    }
    return memberNameById.get(ownerId) ?? ownerId;
  };

  const sharedAudienceLabel = (key: CustomKey): string => {
    const audience =
      key.sharedShareScope === "org"
        ? "Organization"
        : key.sharedShareScope === "namespace"
          ? "Team"
          : key.sharedShareScope === "members"
            ? "Selected members"
            : "Shared";
    const owner = sharedOwnerLabel(key);
    if (owner) {
      return `Shared by ${owner} · ${audience}`;
    }
    return `Shared · ${audience}`;
  };

  const shareBlockedLabel = (key: CustomKey): string => {
    const ownerId = key.vaultShareBlockedOwnerUserId?.trim().toLowerCase();
    const owner = ownerId ? memberNameById.get(ownerId) ?? ownerId : "a teammate";
    const audience = formatVaultAudienceLabel(key.vaultAudience);
    return `Not shared (${audience}) — ${key.name} already exists (${owner})`;
  };

  const syncVaultAfterOwnerChange = async (input: {
    name: string;
    previousAudience: IntegrationKeyVaultAudience;
    nextAudience?: IntegrationKeyVaultAudience;
    targetOrgId?: string;
    mode: "delete" | "update";
  }) => {
    const result = await syncVaultKeyChange(input);
    await loadKeys({ force: true });
    if (!result.success) {
      alert(`Vault sync failed: ${result.error ?? "Unknown error"}`);
      return result;
    }
    const conflict = result.conflicts?.find(
      (item) => item.name.toUpperCase() === input.name.toUpperCase(),
    );
    if (conflict) {
      const ownerId = conflict.ownerUserId?.trim().toLowerCase();
      const owner = ownerId ? memberNameById.get(ownerId) ?? ownerId : "a teammate";
      alert(
        `Not shared — ${input.name} already exists in the cloud vault (owned by ${owner}). ` +
          "Your key still works locally on this device.",
      );
    }
    return result;
  };

  const handleStartView = async (keyItem: KeyDisplayItem) => {
    setViewingKeyId(keyItem.id);
    setShowViewValue(false);
    setViewValue("");
    setLoadingViewValue(true);
    try {
      const value = await getKeyValue(keyItem.id);
      setViewValue(value ?? "");
    } catch {
      setViewValue("");
    } finally {
      setLoadingViewValue(false);
    }
  };

  const handleStartEdit = async (keyItem: KeyDisplayItem) => {
    if (isSharedMirror(keyItem)) {
      return;
    }
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
    setEditMemberIds(keyItem.vaultAudienceMemberIds ?? []);
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
    if (editVaultAudience === "members" && editMemberIds.length === 0) {
      alert("Select at least one workspace member to share this key with.");
      return;
    }
    try {
      const scopeInput = toOrgScopeInput(editOrgScope);
      const updates: Partial<CustomKeyInput> = {
        name: keyItem.name,
        description: keyItem.description,
        permission: editPermission,
        clientAccess: editClientAccess,
        vaultAudience: editVaultAudience,
        vaultAudienceMemberIds:
          editVaultAudience === "members" ? editMemberIds : [],
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
      const previousAudience = keyItem.vaultAudience ?? "user";
      await updateKey(keyItem.id, updates);
      await syncVaultAfterOwnerChange({
        name: keyItem.name,
        previousAudience,
        nextAudience: editVaultAudience,
        targetOrgId: scopeInput.organizationId,
        mode: "update",
      });
      setEditingKeyId(null);
      setEditValue("");
      setShowEditValue(false);
      setEditMemberIds([]);
    } catch (err) {
      console.error("Error saving key:", err);
      alert("Failed to save key. Please try again.");
    }
  };

  const handleDeleteKey = async (keyItem: KeyDisplayItem) => {
    const prompt = isSharedMirror(keyItem)
      ? `Remove ${keyItem.name} from this device? The shared key will remain available in the cloud vault.`
      : `Are you sure you want to delete ${keyItem.name}? This removes it from the cloud vault for your team.`;
    if (!confirm(prompt)) {
      return;
    }
    if (isSharedMirror(keyItem)) {
      await deleteKey(keyItem.id);
      return;
    }
    const syncResult = await syncVaultAfterOwnerChange({
      name: keyItem.name,
      previousAudience: keyItem.vaultAudience ?? "user",
      mode: "delete",
      targetOrgId: keyItem.organizationId,
    });
    if (!syncResult.success) {
      return;
    }
    await deleteKey(keyItem.id);
  };

  const handleAddCustomKey = async () => {
    if (!keyForm.name || !keyForm.value) {
      alert("Please enter both key name and value");
      return;
    }
    if (addVaultAudience === "members" && addMemberIds.length === 0) {
      alert("Select at least one workspace member to share this key with.");
      return;
    }
    const existingShared = integrationKeys.find(
      (item) =>
        item.name.toUpperCase() === keyForm.name.toUpperCase() &&
        item.vaultOrigin === "shared",
    );
    if (existingShared) {
      alert(
        `${keyForm.name} is already available as a shared key from a teammate. ` +
          "Use View, or remove it from this device if you need your own copy.",
      );
      return;
    }
    const success = await addKey({
      ...keyForm,
      vaultAudience: addVaultAudience,
      vaultAudienceMemberIds:
        addVaultAudience === "members" ? addMemberIds : undefined,
      ...toOrgScopeInput(addOrgScope),
    });
    if (success) {
      await syncVaultAfterOwnerChange({
        name: keyForm.name,
        previousAudience: "user",
        nextAudience: addVaultAudience,
        targetOrgId: toOrgScopeInput(addOrgScope).organizationId,
        mode: "update",
      });
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
      setAddMemberIds([]);
      setShowAddKeyValue(false);
    }
  };

  const formatDate = (date?: string) => {
    if (!date) return "";
    return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div className="settings-content settings-content--full-width">
      <div className="settings-section">
        <div className="settings-section__header">
          <div>
            <h2 className="settings-section__title">Key Vault</h2>
            <p className="settings-section__description">
              API keys for jobs, automations, and third-party services.
              Choose organization scope and who can use each key (only you, team, or organization).
            </p>
            {refreshingShared && (
              <p className="key-vault-refreshing" aria-live="polite">
                Refreshing shared keys…
              </p>
            )}
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
            {addVaultAudience === "members" && (
              <IntegrationKeyMemberPicker
                idPrefix="add-vault-members"
                members={workspaceMembers.filter(
                  (member) =>
                    !currentUserId ||
                    member.userId.toLowerCase() !== currentUserId.toLowerCase(),
                )}
                selectedUserIds={addMemberIds}
                onChange={setAddMemberIds}
              />
            )}
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
            <p>No keys in this vault yet.</p>
            <p className="key-empty__hint">
              Add organization-only keys here, or choose &quot;All organizations&quot; for shared keys like a team Stripe account.
            </p>
          </div>
        ) : (
          <div className="key-list">
            {filteredKeys.map((keyItem) => (
              <div
                key={keyItem.id}
                className={`key-item${isSharedMirror(keyItem) ? " key-item--shared" : ""}`}
              >
                {viewingKeyId === keyItem.id ? (
                  <div className="key-item__view">
                    <div className="key-item__edit-header">
                      <span className="key-item__name">{keyItem.name}</span>
                      <span className="key-item__scope-badge key-item__scope-badge--shared">
                        {sharedAudienceLabel(keyItem)}
                      </span>
                    </div>
                    <p className="key-item__view-note">
                      Read-only — shared by a teammate. You can use this key in jobs and bash,
                      but only the owner can change audience or value in the cloud vault.
                    </p>
                    {keyItem.description && (
                      <div className="form-group">
                        <label className="form-label">Description</label>
                        <p className="key-item__view-field">{keyItem.description}</p>
                      </div>
                    )}
                    <IntegrationKeyOptionsRow>
                      <IntegrationKeySelectField
                        id={`integration-key-view-permission-${keyItem.id}`}
                        label="Permission"
                        info={INTEGRATION_KEY_PERMISSION_INFO}
                        value={keyItem.permission}
                        options={[...INTEGRATION_KEY_PERMISSION_OPTIONS]}
                        onChange={() => undefined}
                        disabled
                      />
                      <IntegrationKeySelectField
                        id={`integration-key-view-client-access-${keyItem.id}`}
                        label="Browser access"
                        info={INTEGRATION_KEY_CLIENT_ACCESS_INFO}
                        value={keyItem.clientAccess ?? "server"}
                        options={[...INTEGRATION_KEY_CLIENT_ACCESS_OPTIONS]}
                        onChange={() => undefined}
                        disabled
                      />
                    </IntegrationKeyOptionsRow>
                    <div className="form-group">
                      <label className="form-label">Value</label>
                      <input
                        type={showViewValue ? "text" : "password"}
                        className="form-input"
                        value={loadingViewValue ? "Loading…" : viewValue}
                        readOnly
                        disabled={loadingViewValue}
                      />
                      <button
                        className="settings-btn settings-btn--small"
                        style={{ marginTop: 4 }}
                        onClick={() => setShowViewValue(!showViewValue)}
                        disabled={loadingViewValue || !viewValue}
                      >
                        {showViewValue ? "Hide" : "Show"}
                      </button>
                    </div>
                    <div className="key-item__edit-actions">
                      <button
                        className="settings-btn settings-btn--secondary"
                        onClick={() => setViewingKeyId(null)}
                      >
                        Close
                      </button>
                    </div>
                  </div>
                ) : editingKeyId === keyItem.id ? (
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
                    {editVaultAudience === "members" && (
                      <IntegrationKeyMemberPicker
                        idPrefix={`edit-vault-members-${keyItem.id}`}
                        members={workspaceMembers.filter(
                          (member) =>
                            !currentUserId ||
                            member.userId.toLowerCase() !==
                              currentUserId.toLowerCase(),
                        )}
                        selectedUserIds={editMemberIds}
                        onChange={setEditMemberIds}
                      />
                    )}
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
                      {isSharedMirror(keyItem) && (
                        <span
                          className="key-item__scope-badge key-item__scope-badge--shared"
                          title="Pulled from cloud vault — read-only on this device"
                        >
                          {sharedAudienceLabel(keyItem)}
                        </span>
                      )}
                      {keyItem.vaultSharedNameCollision && !isSharedMirror(keyItem) && (
                        <span
                          className="key-item__scope-badge key-item__scope-badge--duplicate"
                          title="A teammate also shared this name — your local key is used for ${KEY} substitution"
                        >
                          Duplicate name
                        </span>
                      )}
                      {keyItem.vaultShareBlocked && !isSharedMirror(keyItem) && (
                        <span
                          className="key-item__scope-badge key-item__scope-badge--blocked"
                          title={shareBlockedLabel(keyItem)}
                        >
                          Not shared
                        </span>
                      )}
                      <span
                        className={`key-item__scope-badge ${
                          keyItem.orgScope === "all" ? "key-item__scope-badge--shared" : ""
                        }`}
                      >
                        {scopeLabelForKey(keyItem)}
                        {!isSharedMirror(keyItem) &&
                        keyItem.vaultAudience &&
                        keyItem.vaultAudience !== "user"
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
                      {isSharedMirror(keyItem) ? (
                        <button
                          className="settings-btn settings-btn--small"
                          onClick={() => handleStartView(keyItem)}
                        >
                          View
                        </button>
                      ) : (
                        <button
                          className="settings-btn settings-btn--small"
                          onClick={() => handleStartEdit(keyItem)}
                        >
                          Edit
                        </button>
                      )}
                      <button
                        className="settings-btn settings-btn--small settings-btn--danger"
                        onClick={() => handleDeleteKey(keyItem)}
                      >
                        {isSharedMirror(keyItem) ? "Remove" : "Delete"}
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
