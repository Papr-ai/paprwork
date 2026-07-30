/**
 * CopyAppModal - Copy an app bundle into another org/namespace (source stays put).
 */

import React, { useCallback, useEffect, useState } from "react";
import type { Artifact } from "../../stores/artifactsStore";
import { gateway } from "../../src/lib/gateway";
import { readCachedCloudPublishState } from "../../utils/cloudPublishCache";
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

interface CopyAppModalProps {
  app: Artifact | null;
  currentOrganizationId: string | null;
  currentNamespaceId: string | null;
  onClose: () => void;
  onCopied: () => void;
}

function isSameDestination(
  orgId: string,
  namespaceId: string,
  currentOrganizationId: string | null,
  currentNamespaceId: string | null,
): boolean {
  return (
    Boolean(currentOrganizationId) &&
    Boolean(currentNamespaceId) &&
    orgId === currentOrganizationId &&
    namespaceId === currentNamespaceId
  );
}

export function CopyAppModal({
  app,
  currentOrganizationId,
  currentNamespaceId,
  onClose,
  onCopied,
}: CopyAppModalProps) {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [namespaces, setNamespaces] = useState<NamespaceOption[]>([]);
  const [targetOrganizationId, setTargetOrganizationId] = useState("");
  const [targetNamespaceId, setTargetNamespaceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingNamespaces, setLoadingNamespaces] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOpen = app !== null;
  const isPublished = app
    ? Boolean(readCachedCloudPublishState(app.id)?.shareUrl)
    : false;

  const selectedOrg = organizations.find(
    (org) => org.organizationId === targetOrganizationId,
  );

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
      return result.namespaces
        .filter(
          (ns) =>
            !isSameDestination(
              organizationId,
              ns.id,
              currentOrganizationId,
              currentNamespaceId,
            ),
        )
        .map((ns) => ({ id: ns.id, name: ns.name?.trim() || ns.id }));
    },
    [currentNamespaceId, currentOrganizationId],
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
        options.find((org) => org.organizationId !== currentOrganizationId) ??
        options[0];
      if (preferredOrg) {
        setTargetOrganizationId(preferredOrg.organizationId);
      } else {
        setNamespaces([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load destinations.");
      setOrganizations([]);
      setNamespaces([]);
    } finally {
      setLoading(false);
    }
  }, [currentOrganizationId]);

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
    void (async () => {
      setLoadingNamespaces(true);
      setError(null);
      try {
        const nsOptions = await loadNamespacesForOrg(targetOrganizationId);
        if (cancelled) {
          return;
        }
        setNamespaces(nsOptions);
        setTargetNamespaceId(nsOptions[0]?.id ?? "");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load namespaces.");
          setNamespaces([]);
          setTargetNamespaceId("");
        }
      } finally {
        if (!cancelled) {
          setLoadingNamespaces(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, loadNamespacesForOrg, targetOrganizationId]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !copying) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, copying, onClose]);

  const handleCopy = async () => {
    if (!app || !targetOrganizationId || !targetNamespaceId || copying) {
      return;
    }

    const targetOrgName = selectedOrg?.name ?? "the selected organization";
    const targetNsName =
      namespaces.find((ns) => ns.id === targetNamespaceId)?.name ??
      "the selected namespace";

    const warnings: string[] = [
      `Copy "${app.title}" to ${targetOrgName} → ${targetNsName}?`,
      "",
      "This copies the app, linked jobs, and databases into that workspace.",
      "Nothing is removed here — delete the app from this namespace afterward if you no longer want it.",
    ];
    if (isPublished) {
      warnings.push(
        "",
        "This app is live on the web in the current namespace. Publish again from the copy if you want it live in the new namespace.",
      );
    }

    if (!confirm(warnings.join("\n"))) {
      return;
    }

    setCopying(true);
    setError(null);
    try {
      const response = await gateway.send<{
        appId: string;
        title: string;
        titleRenamed: boolean;
        copiedJobIds: string[];
      }>("app:copy-to-namespace", {
        appId: app.id,
        targetOrganizationId,
        targetNamespaceId,
      });

      const renamedNote = response.data?.titleRenamed
        ? ` Renamed to "${response.data.title}" because that namespace already had an app with the same name.`
        : "";
      const jobNote =
        response.data?.copiedJobIds && response.data.copiedJobIds.length > 0
          ? ` Included ${response.data.copiedJobIds.length} linked job(s).`
          : "";
      alert(`Copied to ${targetOrgName} → ${targetNsName}.${jobNote}${renamedNote}`);
      onCopied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Copy failed.");
    } finally {
      setCopying(false);
    }
  };

  const destinationsReady =
    organizations.length > 0 && namespaces.length > 0 && Boolean(targetNamespaceId);

  if (!isOpen || !app) {
    return null;
  }

  return (
    <div
      className="move-app-modal__backdrop"
      onClick={copying ? undefined : onClose}
    >
      <div
        className="move-app-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-labelledby="copy-app-modal-title"
      >
        <h3 id="copy-app-modal-title" className="move-app-modal__title">
          Copy to workspace
        </h3>
        <p className="move-app-modal__subtitle">
          Copy <strong>{app.title}</strong> and its linked jobs into another
          organization and namespace. Switch workspaces in Settings to open the
          copy there.
        </p>

        {loading ? (
          <p className="move-app-modal__hint">Loading destinations…</p>
        ) : organizations.length === 0 ? (
          <p className="move-app-modal__hint">
            No organizations available. Sign in to Papr to copy apps across
            workspaces.
          </p>
        ) : (
          <>
            <label className="move-app-modal__label">
              Organization
              <select
                className="move-app-modal__select"
                value={targetOrganizationId}
                onChange={(event) => setTargetOrganizationId(event.target.value)}
                disabled={copying || organizations.length <= 1}
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
                <span className="move-app-modal__hint">
                  No other namespaces in this organization.
                </span>
              ) : (
                <select
                  className="move-app-modal__select"
                  value={targetNamespaceId}
                  onChange={(event) => setTargetNamespaceId(event.target.value)}
                  disabled={copying}
                >
                  {namespaces.map((ns) => (
                    <option key={ns.id} value={ns.id}>
                      {ns.name}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </>
        )}

        {isPublished && (
          <p className="move-app-modal__warning">
            The live web link stays tied to this namespace until you publish the
            copy separately.
          </p>
        )}

        {error && <p className="move-app-modal__error">{error}</p>}

        <div className="move-app-modal__actions">
          <button
            type="button"
            className="move-app-modal__btn move-app-modal__btn--secondary"
            onClick={onClose}
            disabled={copying}
          >
            Cancel
          </button>
          <button
            type="button"
            className="move-app-modal__btn move-app-modal__btn--primary"
            onClick={() => void handleCopy()}
            disabled={copying || loading || loadingNamespaces || !destinationsReady}
          >
            {copying ? "Copying…" : "Copy app"}
          </button>
        </div>
      </div>
    </div>
  );
}
