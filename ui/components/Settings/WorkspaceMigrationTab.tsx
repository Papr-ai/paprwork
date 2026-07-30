/**
 * Settings → Workspace migration — optional user-initiated moves and assignments.
 */

import React, { useCallback, useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { useChat } from "../../hooks/useChat";
import { useTabs } from "../../hooks/useTabs";
import { usePaprNamespace } from "../../hooks/usePaprNamespace";
import { reloadUiForWorkspaceSwitch } from "../../lib/workspaceSwitchReload";
import { useChatStore } from "../../stores/chatStore";
import type { Artifact } from "../../stores/artifactsStore";
import { AssignAppWorkspaceModal } from "../Apps/AssignAppWorkspaceModal";
import "./WorkspaceMigrationTab.css";

interface NamespaceOption {
  id: string;
  name: string;
}

interface OrganizationOption {
  workspaceId: string;
  name: string;
  organizationId: string;
}

function formatEntryPreview(entries: string[]): string {
  const preview = entries.slice(0, 8);
  const suffix = entries.length > 8 ? ` and ${entries.length - 8} more` : "";
  return preview.join(", ") + suffix;
}

function formatWorkspaceTarget(
  organizationName: string | undefined,
  namespaceName: string,
): string {
  const org = organizationName?.trim();
  const ns = namespaceName.trim() || "your workspace";
  return org ? `${org} · ${ns}` : ns;
}

const AGENT_HELP_MESSAGE = `I need help organizing my Papr workspace (apps, jobs, and database links).

Please:
1. Confirm my active org/namespace and $PAPR_HOME paths.
2. Find any apps or jobs still pointing at old flat ~/Papr paths or another namespace.
3. Fix data-sources.json and job commands to use the current workspace.
4. Summarize what you changed and anything I should migrate manually in Settings → Workspace migration.`;

export function WorkspaceMigrationTab() {
  const papr = usePaprNamespace();
  const { createChat } = useChat();
  const { createTab, switchToTab } = useTabs();

  const [legacyEntries, setLegacyEntries] = useState<string[]>([]);
  const [legacyLoading, setLegacyLoading] = useState(true);
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [namespaces, setNamespaces] = useState<NamespaceOption[]>([]);
  const [targetOrganizationId, setTargetOrganizationId] = useState("");
  const [targetNamespaceId, setTargetNamespaceId] = useState("");
  const [loadingTargets, setLoadingTargets] = useState(true);
  const [loadingNamespaces, setLoadingNamespaces] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);

  const [unassigned, setUnassigned] = useState<Artifact[]>([]);
  const [unassignedLoading, setUnassignedLoading] = useState(false);
  const [assignTarget, setAssignTarget] = useState<Artifact | null>(null);
  const [currentOrganizationId, setCurrentOrganizationId] = useState<string | null>(
    null,
  );

  const loadLegacyDetection = useCallback(async () => {
    setLegacyLoading(true);
    try {
      const result = await window.electronAPI.papr.detectLegacyFlatMigration();
      if (result.success && result.needsUserConsent && result.entries?.length) {
        setLegacyEntries(result.entries);
      } else {
        setLegacyEntries([]);
      }
    } catch {
      setLegacyEntries([]);
    } finally {
      setLegacyLoading(false);
    }
  }, []);

  const loadUnassigned = useCallback(async () => {
    if (!papr.namespaceId) {
      setUnassigned([]);
      return;
    }
    setUnassignedLoading(true);
    try {
      const workspace = await window.electronAPI.papr.getActiveWorkspace();
      const orgId = workspace.success ? workspace.pointer?.organizationId ?? null : null;
      setCurrentOrganizationId(orgId);
      const response = await gateway.send("app:list-unassigned");
      setUnassigned((response.data as Artifact[]) ?? []);
    } catch {
      setUnassigned([]);
    } finally {
      setUnassignedLoading(false);
    }
  }, [papr.namespaceId]);

  const loadNamespacesForOrg = useCallback(
    async (organizationId: string): Promise<NamespaceOption[]> => {
      const result = await window.electronAPI.papr.listNamespaces({
        organizationId,
        forceRefresh: true,
      });
      if (!result.success || !result.namespaces?.length) {
        throw new Error(result.error ?? "Could not load workspaces.");
      }
      return result.namespaces.map((ns) => ({
        id: ns.id,
        name: ns.name?.trim() || ns.id,
      }));
    },
    [],
  );

  const loadMigrationTargets = useCallback(async () => {
    setLoadingTargets(true);
    setMigrationError(null);
    try {
      const [workspace, orgResult] = await Promise.all([
        window.electronAPI.papr.getActiveWorkspace(),
        window.electronAPI.papr.listOrganizations(),
      ]);

      if (!orgResult.success || !orgResult.organizations?.length) {
        setOrganizations([]);
        setNamespaces([]);
        return;
      }

      const options: OrganizationOption[] = orgResult.organizations
        .map((org) => ({
          workspaceId: org.id,
          name: org.name?.trim() || org.organizationName?.trim() || org.id,
          organizationId: org.organizationId ?? org.id,
        }))
        .filter((org) => Boolean(org.organizationId));

      setOrganizations(options);

      const currentOrgId = workspace.success
        ? workspace.pointer?.organizationId
        : undefined;
      const preferredOrg =
        options.find((org) => org.organizationId === currentOrgId) ??
        options.find((org) => org.organizationId === orgResult.activeOrganizationId) ??
        options[0];

      if (preferredOrg) {
        setTargetOrganizationId(preferredOrg.organizationId);
      }

      const activeNsId = workspace.success ? workspace.pointer?.namespaceId : undefined;
      if (activeNsId) {
        setTargetNamespaceId(activeNsId);
      }
    } catch (err) {
      setMigrationError(
        err instanceof Error ? err.message : "Could not load organizations.",
      );
    } finally {
      setLoadingTargets(false);
    }
  }, []);

  useEffect(() => {
    void loadLegacyDetection();
    void loadUnassigned();
    void loadMigrationTargets();
  }, [loadLegacyDetection, loadUnassigned, loadMigrationTargets]);

  useEffect(() => {
    if (!targetOrganizationId || loadingTargets) {
      return;
    }

    let cancelled = false;
    setLoadingNamespaces(true);
    void loadNamespacesForOrg(targetOrganizationId)
      .then((nsList) => {
        if (cancelled) {
          return;
        }
        setNamespaces(nsList);
        setTargetNamespaceId((prev) =>
          nsList.some((ns) => ns.id === prev) ? prev : (nsList[0]?.id ?? ""),
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setMigrationError(
            err instanceof Error ? err.message : "Could not load namespaces.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingNamespaces(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [targetOrganizationId, loadNamespacesForOrg, loadingTargets]);

  const selectedOrganization = organizations.find(
    (org) => org.organizationId === targetOrganizationId,
  );
  const targetNamespaceName =
    namespaces.find((ns) => ns.id === targetNamespaceId)?.name ?? "your workspace";
  const targetWorkspaceLabel = formatWorkspaceTarget(
    selectedOrganization?.name,
    targetNamespaceName,
  );

  const handleMigrateFlatPapr = async () => {
    if (!targetOrganizationId || !targetNamespaceId || migrating) {
      return;
    }

    setMigrating(true);
    setMigrationError(null);
    try {
      const result = await window.electronAPI.papr.runConsentLegacyMigration({
        organizationId: targetOrganizationId,
        namespaceId: targetNamespaceId,
        organizationName: selectedOrganization?.name,
        namespaceName: targetNamespaceName,
      });

      if (!result.success) {
        setMigrationError(result.error ?? "Migration failed.");
        return;
      }

      await reloadUiForWorkspaceSwitch();
      await loadLegacyDetection();
      await loadUnassigned();
    } catch (err) {
      setMigrationError(
        err instanceof Error ? err.message : "Migration failed.",
      );
    } finally {
      setMigrating(false);
    }
  };

  const handleAskAgent = async () => {
    const chatId = await createChat();
    if (!chatId) {
      return;
    }
    useChatStore.getState().setDraftMessage(chatId, AGENT_HELP_MESSAGE);
    const tabId = createTab("chat", chatId, "Workspace migration");
    switchToTab(tabId);
  };

  const showFlatMigration =
    !legacyLoading && legacyEntries.length > 0 && papr.isLoggedIn;

  return (
    <div className="settings-content workspace-migration-tab">
      <div className="settings-section">
        <h2 className="settings-section__title">Workspace migration</h2>
        <p className="settings-section__description">
          Papr keeps apps, jobs, and data inside your active organization and
          namespace. Use this page when you still have content from an older flat{" "}
          <code>~/Papr</code> folder or apps that are not assigned to a workspace
          yet. Nothing runs automatically — you choose when to migrate.
        </p>

        <button
          type="button"
          className="settings-btn settings-btn--secondary workspace-migration-tab__agent-btn"
          onClick={() => void handleAskAgent()}
        >
          Ask agent for help
        </button>
      </div>

      {showFlatMigration ? (
        <div className="settings-section workspace-migration-tab__card">
          <h3 className="workspace-migration-tab__subtitle">
            Move from ~/Papr
          </h3>
          <p className="settings-section__description">
            We found existing files in your Papr folder that should live in an
            org/namespace workspace. Includes:{" "}
            {formatEntryPreview(legacyEntries)}.
          </p>

          {organizations.length > 1 ? (
            <label className="workspace-migration-tab__field">
              <span>Organization</span>
              <select
                value={targetOrganizationId}
                onChange={(event) => setTargetOrganizationId(event.target.value)}
                disabled={migrating}
              >
                {organizations.map((org) => (
                  <option key={org.organizationId} value={org.organizationId}>
                    {org.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {namespaces.length > 1 ? (
            <label className="workspace-migration-tab__field">
              <span>Move into workspace</span>
              <select
                value={targetNamespaceId}
                onChange={(event) => setTargetNamespaceId(event.target.value)}
                disabled={migrating || loadingNamespaces}
              >
                {namespaces.map((ns) => (
                  <option key={ns.id} value={ns.id}>
                    {formatWorkspaceTarget(selectedOrganization?.name, ns.name)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="workspace-migration-tab__target">
              Target: <strong>{targetWorkspaceLabel}</strong>
            </p>
          )}

          {migrationError ? (
            <p className="workspace-migration-tab__error">{migrationError}</p>
          ) : null}

          <button
            type="button"
            className="settings-btn settings-btn--primary"
            disabled={
              migrating ||
              loadingTargets ||
              loadingNamespaces ||
              !targetOrganizationId ||
              !targetNamespaceId
            }
            onClick={() => void handleMigrateFlatPapr()}
          >
            {migrating ? "Moving files…" : "Move to selected workspace"}
          </button>
        </div>
      ) : legacyLoading ? (
        <div className="settings-section">
          <p className="settings-section__description">Checking for legacy files…</p>
        </div>
      ) : null}

      {papr.isLoggedIn ? (
        <div className="settings-section workspace-migration-tab__card">
          <h3 className="workspace-migration-tab__subtitle">Unassigned apps</h3>
          <p className="settings-section__description">
            Apps on disk that are not linked to an org/namespace yet. Assign them
            to your current workspace so they appear in My Apps.
          </p>

          {unassignedLoading && unassigned.length === 0 ? (
            <p className="settings-section__description">Loading…</p>
          ) : unassigned.length === 0 ? (
            <p className="settings-section__description">
              No unassigned apps found in this folder.
            </p>
          ) : (
            <ul className="workspace-migration-tab__app-list">
              {unassigned.map((app) => (
                <li key={app.id} className="workspace-migration-tab__app-item">
                  <div className="workspace-migration-tab__app-meta">
                    <span className="workspace-migration-tab__app-title">{app.title}</span>
                    {app.description ? (
                      <span className="workspace-migration-tab__app-desc">
                        {app.description}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="settings-btn settings-btn--secondary workspace-migration-tab__assign-btn"
                    onClick={() => setAssignTarget(app)}
                  >
                    Assign…
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="settings-section">
          <p className="settings-section__description">
            Sign in to Papr to migrate content into an org/namespace workspace.
          </p>
        </div>
      )}

      <AssignAppWorkspaceModal
        app={assignTarget}
        currentOrganizationId={currentOrganizationId}
        currentNamespaceId={papr.namespaceId ?? null}
        onClose={() => setAssignTarget(null)}
        onAssigned={() => {
          void loadUnassigned();
          window.dispatchEvent(new Event("app:list-updated"));
        }}
      />
    </div>
  );
}
