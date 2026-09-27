/**
 * AppsView - Wabi-inspired app gallery with Liquid Glass design
 * Clean, minimal interface focused on app discovery and creation
 */

import React, { useState, useCallback, useMemo, useEffect } from "react";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useTabs } from "../../hooks/useTabs";
import { gateway } from "../../src/lib/gateway";
import { type AppStatus } from "./AppCard";
import { CommunityAppsView } from "./CommunityAppsView";
import { AppsSidebar } from "./AppsSidebar";
import { LibraryPane } from "./LibraryPane";
import { DuplicateCleanupView } from "./DuplicateCleanupView";
import { useAppsHealth } from "../../hooks/useAppsHealth";
import {
  findDuplicateGroups,
  isLibrarySection,
  sectionCounts,
  type AppsSection,
  type LibrarySection,
} from "../../utils/appsLibrary";
import { CreateAppModal } from "./CreateAppModal";
import { CopyAppModal } from "./CopyAppModal";
import { DeleteAppModal } from "./DeleteAppModal";
import { usePaprNamespace } from "../../hooks/usePaprNamespace";
import "./AppsView.css";
import type { Artifact } from "../../stores/artifactsStore";
import {
  readCachedCloudPublishState,
  readCachedCloudPublishStates,
  selectAppIdsForPublishRevalidation,
  writeCachedCloudPublishState,
} from "../../utils/cloudPublishCache";
import { fetchCloudPublishState } from "../../utils/cloudPublishApi";
import {
  readAppsSection,
  toAppsSection,
  writeAppsSection,
} from "../../utils/appsViewTabPersistence";

export type { AppStatus };

const lastActivity = (a: Artifact) =>
  new Date(a.lastOpenedAt ?? a.updatedAt).getTime();

export function AppsView() {
  const {
    filteredArtifacts,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    deleteArtifact,
    toggleFavorite,
    loadArtifacts,
  } = useArtifacts("apps");
  const { createTab, switchToTab } = useTabs();
  const papr = usePaprNamespace();

  const showNamespaceTabs = papr.isLoggedIn && Boolean(papr.namespaceId);


  const [section, setSectionState] = useState<AppsSection>(
    () => readAppsSection() ?? "recent",
  );
  const [cleaningUp, setCleaningUp] = useState(false);
  const setSection = useCallback((next: AppsSection) => {
    setSectionState(next);
    setCleaningUp(false);
    writeAppsSection(next);
  }, []);
  const { health, refresh: refreshHealth } = useAppsHealth();
  const [publishRevision, setPublishRevision] = useState(0);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [copyAppTarget, setCopyAppTarget] = useState<Artifact | null>(null);
  const [deletePreview, setDeletePreview] = useState<{
    appId: string;
    appTitle: string;
    isPublished: boolean;
    shareUrl?: string | null;
    linkedJobs: Array<{ id: string; name: string; type: string; hasTursoDb?: boolean }>;
    tursoDbCount: number;
  } | null>(null);
  const [deleteModalError, setDeleteModalError] = useState<string | null>(null);
  const [otherNamespaceCount, setOtherNamespaceCount] = useState(0);
  const [otherOrganizationCount, setOtherOrganizationCount] = useState(0);
  const [currentOrganizationId, setCurrentOrganizationId] = useState<string | null>(
    null,
  );
  const [catalogSearchQuery, setCatalogSearchQuery] = useState("");
  const [catalogRefreshToken, setCatalogRefreshToken] = useState(0);

  useEffect(() => {
    const onWorkspaceSwitchComplete = () => {
      void loadArtifacts({ forceRefresh: true });
      setPublishRevision((value) => value + 1);
      setCatalogRefreshToken((token) => token + 1);
    };
    const onWorkspaceSwitchStart = () => {
      setCatalogRefreshToken((token) => token + 1);
    };
    window.addEventListener(
      "papr-workspace-switch-complete",
      onWorkspaceSwitchComplete,
    );
    window.addEventListener("papr-workspace-switch-start", onWorkspaceSwitchStart);
    window.addEventListener("papr-workspace-artifacts-ready", onWorkspaceSwitchComplete);
    return () => {
      window.removeEventListener(
        "papr-workspace-switch-complete",
        onWorkspaceSwitchComplete,
      );
      window.removeEventListener(
        "papr-workspace-switch-start",
        onWorkspaceSwitchStart,
      );
      window.removeEventListener(
        "papr-workspace-artifacts-ready",
        onWorkspaceSwitchComplete,
      );
    };
  }, [loadArtifacts]);

  useEffect(() => {
    const onAppsTab = (event: Event) => {
      const next = toAppsSection((event as CustomEvent<{ tab?: string }>).detail?.tab);
      if (next) setSection(next);
    };
    window.addEventListener("papr-apps-view-tab", onAppsTab);
    return () => window.removeEventListener("papr-apps-view-tab", onAppsTab);
  }, [setSection]);

  useEffect(() => {
    if (papr.loading) {
      return;
    }
    if (!showNamespaceTabs && section === "team") {
      setSection("recent");
    }
  }, [papr.loading, showNamespaceTabs, section, setSection]);

  useEffect(() => {
    setCatalogSearchQuery("");
  }, [section]);

  // The catalog refreshes itself when the window regains focus, replacing the
  // old bare "↻" button. Its own caches (30 min UI / 5 min gateway) keep this cheap.
  useEffect(() => {
    const onFocus = () => {
      if (section === "team" || section === "community") {
        window.dispatchEvent(new CustomEvent("papr-community-catalog-refresh"));
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [section]);

  useEffect(() => {
    if (!papr.isLoggedIn || !papr.namespaceId) {
      setOtherNamespaceCount(0);
      setOtherOrganizationCount(0);
      setCurrentOrganizationId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const workspace = await window.electronAPI.papr.getActiveWorkspace();
      const orgId = workspace.success ? workspace.pointer?.organizationId : null;
      if (!orgId) {
        if (!cancelled) {
          setOtherNamespaceCount(0);
          setOtherOrganizationCount(0);
          setCurrentOrganizationId(null);
        }
        return;
      }
      if (!cancelled) {
        setCurrentOrganizationId(orgId);
      }

      const [namespaceResult, organizationResult] = await Promise.all([
        window.electronAPI.papr.listNamespaces({ organizationId: orgId }),
        window.electronAPI.papr.listOrganizations(),
      ]);
      if (cancelled) {
        return;
      }

      const namespaceCount =
        namespaceResult.success && namespaceResult.namespaces
          ? namespaceResult.namespaces.filter((ns) => ns.id !== papr.namespaceId)
              .length
          : 0;
      const organizationCount = organizationResult.success
        ? (organizationResult.organizations?.length ?? 0)
        : 0;

      setOtherNamespaceCount(namespaceCount);
      setOtherOrganizationCount(organizationCount);
    })();
    return () => {
      cancelled = true;
    };
  }, [papr.isLoggedIn, papr.namespaceId]);

  const showCopyAction =
    showNamespaceTabs &&
    (otherOrganizationCount > 1 || otherNamespaceCount > 0);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };

  const handleDelete = async (id: string) => {
    try {
      // First call to get the deletion preview
      const result = await deleteArtifact(id, "app");
      if (result?.preview) {
        setDeleteModalError(null);
        setDeletePreview(result.preview);
      }
    } catch {
      /* useArtifacts sets error */
    }
  };

  const handleConfirmDelete = async (options: {
    deleteLinkedJobs: boolean;
    deleteTursoDatabases: boolean;
    deleteRegistryDbIds: string[];
    deleteRegistryTurso: boolean;
    unpublishFromCloud: boolean;
  }) => {
    if (!deletePreview) return;

    setDeleteModalError(null);
    try {
      await deleteArtifact(deletePreview.appId, "app", {
        ...options,
        confirmed: true,
      });
      setDeletePreview(null);
      setDeleteModalError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to delete app";
      setDeleteModalError(message);
    }
  };

  const handleToggleFavorite = async (id: string) => {
    await toggleFavorite(id, "app");
  };

  const handleOpen = (app: Artifact) => {
    const tabId = createTab(
      "app",
      app.id,
      app.title,
      app.icon ? { icon: app.icon } : {},
    );
    switchToTab(tabId);
    // Record open for recency sorting (fire-and-forget)
    void gateway
      .send("app:update", {
        appId: app.id,
        lastOpenedAt: new Date().toISOString(),
        openCount: (app.openCount ?? 0) + 1,
      })
      .then(() => loadArtifacts())
      .catch(() => {});
    refreshHealth();
  };

  const handleSetStatus = useCallback(
    async (id: string, status: AppStatus) => {
      if (
        status === "archived" &&
        Boolean(readCachedCloudPublishState(id)?.shareUrl) &&
        !confirm(
          "This app is published to the web and will stay live. Archive it locally anyway?\n\nTo take it offline, unpublish it from the app's share settings first.",
        )
      ) {
        return;
      }
      await gateway.send("app:update", { appId: id, status });
      // Archiving used to make the card vanish with no feedback, which reads as
      // "deleted" — so a misclick felt unrecoverable. Move the list to Archived
      // instead: the user sees exactly where the app went, and Unarchive is one
      // menu away rather than something they have to go hunting for.
      if (status === "archived") setSection("archived");
      loadArtifacts();
    },
    [loadArtifacts, setSection],
  );

  const handleRename = useCallback(
    async (id: string, newTitle: string) => {
      await gateway.send("app:update", { appId: id, title: newTitle });
      loadArtifacts();
    },
    [loadArtifacts],
  );

  const allApps = useMemo(
    () => filteredArtifacts.filter((a) => a.type === "app"),
    [filteredArtifacts],
  );

  // Parse the cache once. A cloud-synced app is only "Live" when it has
  // an actual published share URL; `enabled` alone can mean pending/setup.
  const publishedIds = useMemo(() => {
    const states = readCachedCloudPublishStates();
    return new Set(
      allApps.filter((a) => Boolean(states[a.id]?.shareUrl)).map((a) => a.id),
    );
  }, [allApps, publishRevision]);

  // Revalidate publish state after the app grid paints (stale-while-revalidate).
  useEffect(() => {
    const cached = readCachedCloudPublishStates();
    const ids = selectAppIdsForPublishRevalidation(
      allApps.map((app) => app.id),
      cached,
    );
    if (ids.length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      for (let index = 0; index < ids.length && !cancelled; index += 4) {
        const batch = ids.slice(index, index + 4);
        const results = await Promise.allSettled(
          batch.map(async (id) => ({
            id,
            state: await fetchCloudPublishState(id),
          })),
        );
        if (cancelled) return;
        for (const result of results) {
          if (result.status === "fulfilled") {
            const { id, state } = result.value;
            if (state && state.appId && state.appId !== id) {
              continue;
            }
            writeCachedCloudPublishState(id, state);
          }
        }
        setPublishRevision((value) => value + 1);
      }
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [allApps]);

  // Library sorted once by recency; sections, stacking and banners read from it.
  const sortedApps = useMemo(
    () => [...allApps].sort((a, b) => lastActivity(b) - lastActivity(a)),
    [allApps],
  );
  const counts = useMemo(
    () => sectionCounts(sortedApps, { publishedIds, health }),
    [sortedApps, publishedIds, health],
  );
  const duplicateGroups = useMemo(
    () => findDuplicateGroups(sortedApps, lastActivity),
    [sortedApps],
  );
  const duplicateExtraCount = duplicateGroups.reduce((n, g) => n + g.length - 1, 0);

  const archiveApps = useCallback(
    async (ids: string[]) => {
      await Promise.all(
        ids.map((appId) => gateway.send("app:update", { appId, status: "archived" })),
      );
      setCleaningUp(false);
      await loadArtifacts({ forceRefresh: true });
    },
    [loadArtifacts],
  );

  const librarySection: LibrarySection = isLibrarySection(section) ? section : "recent";
  const isCatalog = section === "team" || section === "community";
  const searchValue = isCatalog ? catalogSearchQuery : searchQuery;
  const searchPlaceholder =
    section === "team"
      ? "Search team apps…"
      : section === "community"
        ? "Search community apps…"
        : "Search your apps…";

  return (
    <div className="apps-view">
      <header className="apps-view__topbar">
        <h2 className="apps-view__brand">Apps</h2>
        <input
          type="search"
          className="apps-view__topbar-search"
          placeholder={searchPlaceholder}
          value={searchValue}
          onChange={(event) =>
            isCatalog ? setCatalogSearchQuery(event.target.value) : handleSearch(event)
          }
          aria-label={searchPlaceholder.replace("…", "")}
        />
        <div className="apps-view__topbar-grow" />
        <button
          type="button"
          onClick={() => setShowCreateModal(true)}
          className="apps-view__create-btn"
        >
          + New app
        </button>
      </header>

      <div className="apps-view__body">
        <AppsSidebar
          active={section}
          counts={counts}
          showTeam={showNamespaceTabs}
          onSelect={setSection}
        />
        <div className="apps-view__content">
          {section === "community" ? (
            <CommunityAppsView
              scope="global"
              loadingLabel="Loading community apps..."
              searchQuery={catalogSearchQuery}
              onSearchQueryChange={setCatalogSearchQuery}
              hideToolbar
              refreshToken={catalogRefreshToken}
            />
          ) : section === "team" ? (
            <CommunityAppsView
              key={papr.namespaceId ?? "no-namespace"}
              scope="namespace"
              loadingLabel="Loading team apps..."
              namespaceId={papr.namespaceId}
              namespaceName={papr.namespaceName}
              searchQuery={catalogSearchQuery}
              onSearchQueryChange={setCatalogSearchQuery}
              hideToolbar
              refreshToken={catalogRefreshToken}
            />
          ) : loading ? (
            <div className="apps-view__empty">
              <p>Loading apps...</p>
            </div>
          ) : error ? (
            <div className="apps-view__empty">
              <p style={{ color: "var(--error)" }}>{error}</p>
              <button className="apps-view__retry-btn" onClick={() => void loadArtifacts()}>
                Retry
              </button>
            </div>
          ) : allApps.length === 0 ? (
            <div className="apps-view__empty">
              <p className="apps-view__empty-title">Start your library</p>
              <p className="apps-view__empty-subtitle">
                Apps you build or add live here. Describe one and Pen builds it, or see
                what others have made.
              </p>
              <div className="apps-view__empty-actions">
                <button className="apps-view__create-btn" onClick={() => setShowCreateModal(true)}>
                  + New app
                </button>
                <button
                  className="apps-view__empty-community-btn"
                  onClick={() => setSection(showNamespaceTabs ? "team" : "community")}
                >
                  {showNamespaceTabs ? "See what your team uses" : "Browse Community apps"}
                </button>
              </div>
            </div>
          ) : cleaningUp && duplicateGroups.length > 0 ? (
            <DuplicateCleanupView
              groups={duplicateGroups}
              formatWhen={(a) =>
                a.lastOpenedAt
                  ? `Opened ${new Date(a.lastOpenedAt).toLocaleDateString()}`
                  : `Updated ${new Date(a.updatedAt).toLocaleDateString()}`
              }
              onCancel={() => setCleaningUp(false)}
              onArchive={archiveApps}
            />
          ) : (
            <LibraryPane
              section={librarySection}
              apps={sortedApps}
              health={health}
              publishedIds={publishedIds}
              searchQuery={searchQuery}
              showCopyAction={showCopyAction}
              duplicateExtraCount={duplicateExtraCount}
              onSelectSection={setSection}
              onStartCleanup={() => setCleaningUp(true)}
              onOpen={handleOpen}
              onDelete={(id) => void handleDelete(id)}
              onToggleFavorite={(id) => void handleToggleFavorite(id)}
              onRename={(id, t) => void handleRename(id, t)}
              onSetStatus={(id, st) => void handleSetStatus(id, st)}
              onCopy={setCopyAppTarget}
            />
          )}
        </div>
      </div>

      <CreateAppModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />
      <CopyAppModal
        app={copyAppTarget}
        currentOrganizationId={currentOrganizationId}
        currentNamespaceId={papr.namespaceId}
        onClose={() => setCopyAppTarget(null)}
        onCopied={() => {
          void loadArtifacts();
          setPublishRevision((value) => value + 1);
        }}
      />
      <DeleteAppModal
        isOpen={deletePreview !== null}
        preview={deletePreview}
        deleteError={deleteModalError}
        onClose={() => {
          setDeletePreview(null);
          setDeleteModalError(null);
        }}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
