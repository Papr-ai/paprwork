/**
 * AppsView - Wabi-inspired app gallery with Liquid Glass design
 * Clean, minimal interface focused on app discovery and creation
 */

import React, { useState, useCallback, useMemo, useEffect } from "react";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useTabs } from "../../hooks/useTabs";
import { gateway } from "../../src/lib/gateway";
import { AppCard } from "./AppCard";
import { CommunityAppsView } from "./CommunityAppsView";
import { CreateAppModal } from "./CreateAppModal";
import { CopyAppModal } from "./CopyAppModal";
import { usePaprNamespace } from "../../hooks/usePaprNamespace";
import "./AppsView.css";
import type { Artifact } from "../../stores/artifactsStore";
import {
  readCachedCloudPublishState,
  readCachedCloudPublishStates,
  writeCachedCloudPublishState,
} from "../../utils/cloudPublishCache";
import { fetchCloudPublishState } from "../../utils/cloudPublishApi";

type ViewTab = "my-apps" | "namespace-community" | "community";
type SortOption = "recent" | "name";
type StatusFilter =
  | "all"
  | "favorites"
  | "active"
  | "draft"
  | "archived"
  | "published";
export type AppStatus = "draft" | "active" | "archived";

const appStatus = (a: Artifact): AppStatus => a.status ?? "active";
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

  const teamAppsTabTitle = papr.namespaceName?.trim()
    ? `Team and public apps in ${papr.namespaceName}`
    : "Team and public apps in your workspace";

  const renderLibraryFilters = () => (
    <>
      <select
        className="apps-view__inline-select"
        aria-label="Filter apps"
        value={statusFilter}
        onChange={(event) =>
          setStatusFilter(event.target.value as StatusFilter)
        }
      >
        <option value="all">Current apps</option>
        <option value="favorites">Favorites</option>
        <option value="published">
          Published
          {statusCounts.published ? ` (${statusCounts.published})` : ""}
        </option>
        <option value="draft">
          Drafts{statusCounts.draft ? ` (${statusCounts.draft})` : ""}
        </option>
        <option value="archived">
          Archived
          {statusCounts.archived ? ` (${statusCounts.archived})` : ""}
        </option>
      </select>
      <select
        className="apps-view__inline-select"
        aria-label="Sort apps"
        value={sortBy}
        onChange={(event) => setSortBy(event.target.value as SortOption)}
      >
        <option value="recent">Recently opened</option>
        <option value="name">Name A–Z</option>
      </select>
    </>
  );

  const [viewTab, setViewTab] = useState<ViewTab>("my-apps");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [publishRevision, setPublishRevision] = useState(0);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [copyAppTarget, setCopyAppTarget] = useState<Artifact | null>(null);
  const [otherNamespaceCount, setOtherNamespaceCount] = useState(0);
  const [otherOrganizationCount, setOtherOrganizationCount] = useState(0);
  const [currentOrganizationId, setCurrentOrganizationId] = useState<string | null>(
    null,
  );
  const [catalogSearchQuery, setCatalogSearchQuery] = useState("");
  const [catalogRefreshToken, setCatalogRefreshToken] = useState(0);

  useEffect(() => {
    const onWorkspaceChanged = () => {
      void loadArtifacts();
      setPublishRevision((value) => value + 1);
      setCatalogRefreshToken((token) => token + 1);
    };
    window.addEventListener("papr-namespace-changed", onWorkspaceChanged);
    window.addEventListener("papr-organization-changed", onWorkspaceChanged);
    return () => {
      window.removeEventListener("papr-namespace-changed", onWorkspaceChanged);
      window.removeEventListener("papr-organization-changed", onWorkspaceChanged);
    };
  }, [loadArtifacts]);

  useEffect(() => {
    const onAppsTab = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: ViewTab }>).detail?.tab;
      if (
        tab === "community" ||
        tab === "my-apps" ||
        tab === "namespace-community"
      ) {
        setViewTab(tab);
      }
    };
    window.addEventListener("papr-apps-view-tab", onAppsTab);
    return () => window.removeEventListener("papr-apps-view-tab", onAppsTab);
  }, []);

  useEffect(() => {
    if (!showNamespaceTabs && viewTab === "namespace-community") {
      setViewTab("my-apps");
    }
  }, [showNamespaceTabs, viewTab]);

  useEffect(() => {
    setCatalogSearchQuery("");
  }, [viewTab]);

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
    const isPublished = publishedIds.has(id);
    const shareUrl = readCachedCloudPublishState(id)?.shareUrl;

    if (isPublished) {
      const message = shareUrl
        ? `“${allApps.find((a) => a.id === id)?.title ?? "This app"}” is published at:\n${shareUrl}\n\nDeleting will remove it from this workspace AND unpublish it from the web.\n\nContinue?`
        : `This app is published to the web.\n\nDeleting will remove it locally AND unpublish it from apps.papr.ai.\n\nContinue?`;
      if (!confirm(message)) {
        return;
      }
      try {
        await deleteArtifact(id, "app", { unpublishFromCloud: true });
      } catch {
        /* useArtifacts sets error */
      }
      return;
    }

    if (confirm("Are you sure you want to delete this app?")) {
      await deleteArtifact(id, "app");
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
      loadArtifacts();
    },
    [loadArtifacts],
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

  // Revalidate only previously known publish states, after the app grid paints.
  // This prevents cloud status from delaying the Apps tab or flooding the gateway.
  useEffect(() => {
    const cached = readCachedCloudPublishStates();
    const ids = allApps
      .map((app) => app.id)
      .filter((id) => cached[id])
      .sort(
        (a, b) =>
          Number(Boolean(cached[b]?.shareUrl)) -
          Number(Boolean(cached[a]?.shareUrl)),
      )
      .slice(0, 24);
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
            writeCachedCloudPublishState(result.value.id, result.value.state);
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

  // Counts per status for filter chips
  const statusCounts = useMemo(() => {
    const counts = { active: 0, draft: 0, archived: 0, published: 0 };
    for (const a of allApps) {
      const published = publishedIds.has(a.id);
      if (published) counts.published++;
      // Published supersedes draft in the UI, but archived remains visible locally.
      if (!(published && appStatus(a) === "draft")) counts[appStatus(a)]++;
    }
    return counts;
  }, [allApps, publishedIds]);

  // Apply status filter, then sort
  const apps = useMemo(() => {
    let result =
      statusFilter === "all"
        ? allApps.filter((a) => appStatus(a) !== "archived")
        : statusFilter === "published"
          ? allApps.filter((a) => publishedIds.has(a.id))
          : statusFilter === "favorites"
            ? allApps.filter((a) => a.favorite && appStatus(a) !== "archived")
            : allApps.filter(
                (a) =>
                  appStatus(a) === statusFilter &&
                  !(statusFilter === "draft" && publishedIds.has(a.id)),
              );

    switch (sortBy) {
      case "name":
        result = [...result].sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "recent":
      default:
        result = [...result].sort((a, b) => lastActivity(b) - lastActivity(a));
    }

    return result;
  }, [allApps, publishedIds, statusFilter, sortBy]);

  const recentApps = useMemo(
    () =>
      allApps
        .filter((app) => app.lastOpenedAt && appStatus(app) !== "archived")
        .sort((a, b) => lastActivity(b) - lastActivity(a))
        .slice(0, 4),
    [allApps],
  );
  const showRecentApps =
    statusFilter === "all" && !searchQuery.trim() && recentApps.length > 0;

  return (
    <div className="apps-view">
      <header className="apps-view__topbar">
        <h2 className="apps-view__brand">Apps</h2>

        <div className="apps-view__tabs" role="tablist" aria-label="Apps library">
          <button
            type="button"
            role="tab"
            aria-selected={viewTab === "my-apps"}
            className={`apps-view__tab ${viewTab === "my-apps" ? "apps-view__tab--active" : ""}`}
            onClick={() => setViewTab("my-apps")}
          >
            My Apps
          </button>
          {showNamespaceTabs ? (
            <button
              type="button"
              role="tab"
              aria-selected={viewTab === "namespace-community"}
              className={`apps-view__tab ${viewTab === "namespace-community" ? "apps-view__tab--active" : ""}`}
              onClick={() => setViewTab("namespace-community")}
              title={teamAppsTabTitle}
            >
              Team Apps
            </button>
          ) : null}
          <button
            type="button"
            role="tab"
            aria-selected={viewTab === "community"}
            className={`apps-view__tab ${viewTab === "community" ? "apps-view__tab--active" : ""}`}
            onClick={() => setViewTab("community")}
          >
            Community Apps
          </button>
        </div>

        <div className="apps-view__topbar-grow" />

        {viewTab === "my-apps" ? (
          <>
            <input
              type="search"
              className="apps-view__topbar-search"
              placeholder="Search apps…"
              value={searchQuery}
              onChange={handleSearch}
              aria-label="Search apps"
            />
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              className="apps-view__create-btn"
            >
              + Create
            </button>
          </>
        ) : (
          <>
            <input
              type="search"
              className="apps-view__topbar-search"
              placeholder={
                viewTab === "namespace-community"
                  ? "Search team apps…"
                  : "Search community apps…"
              }
              value={catalogSearchQuery}
              onChange={(event) => setCatalogSearchQuery(event.target.value)}
              aria-label={
                viewTab === "namespace-community"
                  ? "Search team apps"
                  : "Search community apps"
              }
            />
            <button
              type="button"
              className="apps-view__topbar-refresh"
              aria-label="Refresh catalog"
              onClick={() => setCatalogRefreshToken((token) => token + 1)}
            >
              ↻
            </button>
          </>
        )}
      </header>

      {viewTab === "community" ? (
        <div className="apps-view__content">
          <CommunityAppsView
            scope="global"
            loadingLabel="Loading community apps..."
            searchQuery={catalogSearchQuery}
            onSearchQueryChange={setCatalogSearchQuery}
            hideToolbar
            refreshToken={catalogRefreshToken}
          />
        </div>
      ) : viewTab === "namespace-community" ? (
        <div className="apps-view__content">
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
        </div>
      ) : (
        <div className="apps-view__content">
            {!loading ? (
              <div className="apps-view__library-toolbar">
                <span className="apps-view__section-label">App library</span>
                <div className="apps-view__library-toolbar-actions">
                  {renderLibraryFilters()}
                  <span className="apps-view__library-count">{apps.length} apps</span>
                </div>
              </div>
            ) : null}

            {loading && (
              <div className="apps-view__empty">
                <p>Loading apps...</p>
              </div>
            )}

            {error && (
              <div className="apps-view__empty">
                <p style={{ color: "var(--error)" }}>{error}</p>
                <button
                  className="apps-view__retry-btn"
                  onClick={loadArtifacts}
                >
                  Retry
                </button>
              </div>
            )}

            {!loading && !error && apps.length === 0 && (
              <div className="apps-view__empty">
                <svg
                  width="64"
                  height="64"
                  viewBox="0 0 24 24"
                  fill="none"
                  opacity="0.2"
                >
                  <rect
                    x="3"
                    y="3"
                    width="7"
                    height="7"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <rect
                    x="14"
                    y="3"
                    width="7"
                    height="7"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <rect
                    x="3"
                    y="14"
                    width="7"
                    height="7"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <rect
                    x="14"
                    y="14"
                    width="7"
                    height="7"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
                <p className="apps-view__empty-title">No apps yet</p>
                <p className="apps-view__empty-subtitle">
                  Import apps built by the community, ask the AI to create one,
                  or build your own above.
                </p>
                <button
                  className="apps-view__empty-community-btn"
                  onClick={() => setViewTab("community")}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <polyline
                      points="7 10 12 15 17 10"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <line
                      x1="12"
                      y1="15"
                      x2="12"
                      y2="3"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Browse Community Apps
                </button>
              </div>
            )}

            {!loading && !error && apps.length > 0 && (
              <>
                {showRecentApps && (
                  <section className="apps-view__recent">
                    <div className="apps-view__section-heading">
                      <span className="apps-view__section-label">
                        Continue working
                      </span>
                      <span>{recentApps.length} recent</span>
                    </div>
                    <div className="apps-view__recent-row">
                      {recentApps.map((app) => (
                        <AppCard
                          key={`recent-${app.id}`}
                          compact
                          isPublished={publishedIds.has(app.id)}
                          artifact={app}
                          onDelete={() => handleDelete(app.id)}
                          onToggleFavorite={() => handleToggleFavorite(app.id)}
                          onOpen={() => handleOpen(app)}
                          onRename={(title) => handleRename(app.id, title)}
                          onSetStatus={(status) =>
                            handleSetStatus(app.id, status)
                          }
                          showCopyAction={showCopyAction}
                          onCopy={() => setCopyAppTarget(app)}
                        />
                      ))}
                    </div>
                  </section>
                )}

                <section className="apps-view__section">
                  <div className="apps-view__grid">
                    {apps.map((app) => (
                      <AppCard
                        key={app.id}
                        isPublished={publishedIds.has(app.id)}
                        artifact={app}
                        onDelete={() => handleDelete(app.id)}
                        onToggleFavorite={() => handleToggleFavorite(app.id)}
                        onOpen={() => handleOpen(app)}
                        onRename={(title) => handleRename(app.id, title)}
                        onSetStatus={(status) =>
                          handleSetStatus(app.id, status)
                        }
                        showCopyAction={showCopyAction}
                        onCopy={() => setCopyAppTarget(app)}
                      />
                    ))}
                  </div>
                </section>
              </>
            )}
          </div>
      )}

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
    </div>
  );
}
