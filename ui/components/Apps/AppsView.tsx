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

  const namespaceCommunityLabel = papr.namespaceName?.trim()
    ? `${papr.namespaceName} Community`
    : "Workspace Community";

  const showNamespaceTabs = papr.isLoggedIn && Boolean(papr.namespaceId);

  const [viewTab, setViewTab] = useState<ViewTab>("my-apps");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [publishRevision, setPublishRevision] = useState(0);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    const onWorkspaceChanged = () => {
      void loadArtifacts();
      setPublishRevision((value) => value + 1);
    };
    window.addEventListener("papr-namespace-changed", onWorkspaceChanged);
    return () =>
      window.removeEventListener("papr-namespace-changed", onWorkspaceChanged);
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

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };

  const handleDelete = async (id: string) => {
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
      {/* Header */}
      <div className="apps-view__header">
        <h2 className="apps-view__title">Apps</h2>

        <div className="apps-view__tabs">
          <button
            className={`apps-view__tab ${viewTab === "my-apps" ? "apps-view__tab--active" : ""}`}
            onClick={() => setViewTab("my-apps")}
          >
            My Apps
          </button>
          {showNamespaceTabs ? (
            <button
              className={`apps-view__tab ${viewTab === "namespace-community" ? "apps-view__tab--active" : ""}`}
              onClick={() => setViewTab("namespace-community")}
              title={`Team and public apps in ${papr.namespaceName ?? "your workspace"}`}
            >
              {namespaceCommunityLabel}
            </button>
          ) : null}
          <button
            className={`apps-view__tab ${viewTab === "community" ? "apps-view__tab--active" : ""}`}
            onClick={() => setViewTab("community")}
          >
            Community
          </button>
        </div>
      </div>

      {viewTab === "community" ? (
        <div className="apps-view__content">
          <CommunityAppsView scope="global" />
        </div>
      ) : viewTab === "namespace-community" ? (
        <div className="apps-view__content">
          <CommunityAppsView
            scope="namespace"
            namespaceId={papr.namespaceId}
            namespaceName={papr.namespaceName}
            userId={papr.userId}
          />
        </div>
      ) : (
        <>
          {/* Controls: search left, sort center, create right */}
          <div className="apps-view__controls">
            <div className="apps-view__controls-left">
              <input
                type="text"
                className="apps-view__search"
                placeholder="Search by name, purpose, tag, or cloud app…"
                value={searchQuery}
                onChange={handleSearch}
              />
              <label className="apps-view__control-field">
                <span>Filter</span>
                <select
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value as StatusFilter)
                  }
                >
                  <option value="all">Current apps</option>
                  <option value="favorites">Favorites</option>
                  <option value="published">
                    Published
                    {statusCounts.published
                      ? ` (${statusCounts.published})`
                      : ""}
                  </option>
                  <option value="draft">
                    Drafts{statusCounts.draft ? ` (${statusCounts.draft})` : ""}
                  </option>
                  <option value="archived">
                    Archived
                    {statusCounts.archived ? ` (${statusCounts.archived})` : ""}
                  </option>
                </select>
              </label>
              <label className="apps-view__control-field">
                <span>Sort by</span>
                <select
                  value={sortBy}
                  onChange={(event) =>
                    setSortBy(event.target.value as SortOption)
                  }
                >
                  <option value="recent">Recently opened</option>
                  <option value="name">Name A–Z</option>
                </select>
              </label>
            </div>

            <button
              onClick={() => setShowCreateModal(true)}
              className="apps-view__create-btn"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Create App
            </button>
          </div>

          {/* Content */}
          <div className="apps-view__content">
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
                        />
                      ))}
                    </div>
                  </section>
                )}

                <section className="apps-view__section">
                  <div className="apps-view__section-heading">
                    <span className="apps-view__section-label">
                      App library
                    </span>
                    <span>{apps.length} apps</span>
                  </div>
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
                      />
                    ))}
                  </div>
                </section>
              </>
            )}
          </div>
        </>
      )}

      <CreateAppModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />
    </div>
  );
}
