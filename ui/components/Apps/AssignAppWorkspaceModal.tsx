/**
 * Assign a mini-app to an org/namespace (moves when target differs from current).
 */

import React, { useCallback, useEffect, useState } from "react";
import type { Artifact } from "../../stores/artifactsStore";
import { gateway } from "../../src/lib/gateway";
import "./MoveAppModal.css";

interface NamespaceOption {
  id: string;
  name: string;
}

interface OrganizationOption {
  workspaceId: string;
  name: string;
  organizationId: string;
  role?: string;
}

interface AssignAppWorkspaceModalProps {
  app: Artifact | null;
  currentOrganizationId: string | null;
  currentNamespaceId: string | null;
  onClose: () => void;
  onAssigned: () => void;
}

export function AssignAppWorkspaceModal({
  app,
  currentOrganizationId,
  currentNamespaceId,
  onClose,
  onAssigned,
}: AssignAppWorkspaceModalProps) {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [namespaces, setNamespaces] = useState<NamespaceOption[]>([]);
  const [targetOrganizationId, setTargetOrganizationId] = useState("");
  const [targetNamespaceId, setTargetNamespaceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingNamespaces, setLoadingNamespaces] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOpen = app !== null;

  const loadNamespacesForOrg = useCallback(
    async (organizationId: string): Promise<NamespaceOption[]> => {
      const result = await window.electronAPI.papr.listNamespaces({
        organizationId,
        forceRefresh: true,
        peek: true,
      });
      if (!result.success || !result.namespaces) {
        throw new Error(result.error ?? "Could not load namespaces.");
      }
      return result.namespaces.map((ns) => ({
        id: ns.id,
        name: ns.name?.trim() || ns.id,
      }));
    },
    [],
  );

  const loadOrganizations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const orgResult = await window.electronAPI.papr.listOrganizations();
      if (!orgResult.success || !orgResult.organizations?.length) {
        setError(orgResult.error ?? "Could not load organizations.");
        setOrganizations([]);
        setNamespaces([]);
        return;
      }

      const options: OrganizationOption[] = orgResult.organizations
        .map((org) => ({
          workspaceId: org.id,
          name: org.name?.trim() || org.organizationName?.trim() || org.id,
          organizationId: org.organizationId ?? org.id,
          role: org.role,
        }))
        .filter((org) => Boolean(org.organizationId));

      setOrganizations(options);

      const preferredOrg =
        options.find((org) => org.organizationId === currentOrganizationId) ??
        options[0];

      if (!preferredOrg) {
        return;
      }

      setTargetOrganizationId(preferredOrg.organizationId);
      setLoadingNamespaces(true);
      const nsList = await loadNamespacesForOrg(preferredOrg.organizationId);
      setNamespaces(nsList);
      const preferredNs =
        nsList.find((ns) => ns.id === currentNamespaceId) ?? nsList[0];
      if (preferredNs) {
        setTargetNamespaceId(preferredNs.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspaces.");
    } finally {
      setLoading(false);
      setLoadingNamespaces(false);
    }
  }, [currentNamespaceId, currentOrganizationId, loadNamespacesForOrg]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    void loadOrganizations();
  }, [isOpen, loadOrganizations]);

  useEffect(() => {
    if (!isOpen || !targetOrganizationId) {
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
          setError(
            err instanceof Error ? err.message : "Failed to load namespaces.",
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
  }, [isOpen, targetOrganizationId, loadNamespacesForOrg]);

  const handleAssign = async () => {
    if (!app || !targetOrganizationId || !targetNamespaceId) {
      return;
    }
    setAssigning(true);
    setError(null);
    try {
      await gateway.send("app:assign-workspace", {
        appId: app.id,
        targetOrganizationId,
        targetNamespaceId,
      });
      onAssigned();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assign app.");
    } finally {
      setAssigning(false);
    }
  };

  const movingAway =
    Boolean(currentOrganizationId) &&
    Boolean(currentNamespaceId) &&
    (targetOrganizationId !== currentOrganizationId ||
      targetNamespaceId !== currentNamespaceId);

  if (!isOpen || !app) {
    return null;
  }

  return (
    <div
      className="move-app-modal__backdrop"
      onClick={assigning ? undefined : onClose}
    >
      <div
        className="move-app-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-labelledby="assign-app-workspace-title"
      >
        <h3 id="assign-app-workspace-title" className="move-app-modal__title">
          Assign to workspace
        </h3>
        <p className="move-app-modal__subtitle">
          Choose where <strong>{app.title}</strong> belongs. It will only appear
          in My Apps for that organization and namespace.
          {movingAway
            ? " The copy in this workspace will be removed after the move."
            : ""}
        </p>

        {loading ? (
          <p className="move-app-modal__hint">Loading workspaces…</p>
        ) : organizations.length === 0 ? (
          <p className="move-app-modal__hint">
            Sign in to Papr to assign apps to a workspace.
          </p>
        ) : (
          <>
            <label className="move-app-modal__label">
              Organization
              <select
                className="move-app-modal__select"
                value={targetOrganizationId}
                onChange={(event) => setTargetOrganizationId(event.target.value)}
                disabled={assigning}
              >
                {organizations.map((org) => (
                  <option key={org.organizationId} value={org.organizationId}>
                    {org.name}
                    {org.role ? ` (${org.role})` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="move-app-modal__label">
              Namespace
              {loadingNamespaces ? (
                <span className="move-app-modal__hint">Loading namespaces…</span>
              ) : namespaces.length === 0 ? (
                <span className="move-app-modal__hint">No namespaces found.</span>
              ) : (
                <select
                  className="move-app-modal__select"
                  value={targetNamespaceId}
                  onChange={(event) => setTargetNamespaceId(event.target.value)}
                  disabled={assigning}
                >
                  {namespaces.map((ns) => (
                    <option key={ns.id} value={ns.id}>
                      {ns.name}
                      {ns.id === currentNamespaceId &&
                      targetOrganizationId === currentOrganizationId
                        ? " (current)"
                        : ""}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </>
        )}

        {error && <p className="move-app-modal__error">{error}</p>}

        <div className="move-app-modal__actions">
          <button
            type="button"
            className="move-app-modal__btn move-app-modal__btn--secondary"
            onClick={onClose}
            disabled={assigning}
          >
            Cancel
          </button>
          <button
            type="button"
            className="move-app-modal__btn move-app-modal__btn--primary"
            onClick={() => void handleAssign()}
            disabled={
              assigning ||
              !targetOrganizationId ||
              !targetNamespaceId ||
              organizations.length === 0
            }
          >
            {assigning ? "Assigning…" : movingAway ? "Move & assign" : "Assign here"}
          </button>
        </div>
      </div>
    </div>
  );
}
