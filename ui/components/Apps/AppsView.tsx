/**
 * AppsView - Wabi-inspired app gallery with Liquid Glass design
 * Clean, minimal interface focused on app discovery and creation
 */

import React, { useState, useCallback, useMemo } from "react";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useTabs } from "../../hooks/useTabs";
import { gateway } from "../../src/lib/gateway";
import { AppCard } from "./AppCard";
import { CommunityAppsView } from "./CommunityAppsView";
import { CreateAppModal } from "./CreateAppModal";
import "./AppsView.css";

type ViewTab = "my-apps" | "community";
type SortOption = "recent" | "name" | "favorites";

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
  } = useArtifacts();
  const { createTab, switchToTab } = useTabs();

  const [viewTab, setViewTab] = useState<ViewTab>("my-apps");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [showCreateModal, setShowCreateModal] = useState(false);

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

  const handleOpen = (id: string, title: string, icon?: string) => {
    const tabId = createTab("app", id, title, icon ? { icon } : {});
    switchToTab(tabId);
  };

  const handleRename = useCallback(
    async (id: string, newTitle: string) => {
      await gateway.send("app:update", { appId: id, title: newTitle });
      loadArtifacts();
    },
    [loadArtifacts],
  );

  // Filter to apps only, then sort/filter
  const apps = useMemo(() => {
    let result = filteredArtifacts.filter((a) => a.type === "app");

    switch (sortBy) {
      case "name":
        result = [...result].sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "favorites":
        // Filter to show only favorited items, sorted by most recent
        result = result.filter((a) => a.favorite);
        result = [...result].sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
        break;
      case "recent":
      default:
        result = [...result].sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
    }

    return result;
  }, [filteredArtifacts, sortBy]);

  // Featured app: most recent favorited, or just most recent
  const featuredApp = useMemo(() => {
    if (apps.length === 0) return null;
    const favorited = apps.find((a) => a.favorite);
    return favorited || apps[0];
  }, [apps]);

  const remainingApps = useMemo(
    () => (featuredApp ? apps.filter((a) => a.id !== featuredApp.id) : apps),
    [apps, featuredApp],
  );

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
          <CommunityAppsView />
        </div>
      ) : (
      <>
      {/* Controls: search left, sort center, create right */}
      <div className="apps-view__controls">
        <div className="apps-view__controls-left">
          <input
            type="text"
            className="apps-view__search"
            placeholder="Search apps..."
            value={searchQuery}
            onChange={handleSearch}
          />
          <div className="apps-view__sort">
            {(["recent", "name", "favorites"] as SortOption[]).map((option) => (
              <button
                key={option}
                className={`apps-view__sort-btn ${sortBy === option ? "apps-view__sort-btn--active" : ""}`}
                onClick={() => setSortBy(option)}
              >
                {option === "recent"
                  ? "Recent"
                  : option === "name"
                    ? "Name"
                    : "Favorites"}
              </button>
            ))}
          </div>
        </div>

        <button
          className="apps-view__create-btn"
          onClick={() => setShowCreateModal(true)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
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
            <button className="apps-view__retry-btn" onClick={loadArtifacts}>
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
            {/* Featured app */}
            {featuredApp && (
              <div className="apps-view__featured">
                <span className="apps-view__section-label">Featured</span>
                <AppCard
                  artifact={featuredApp}
                  featured
                  onDelete={() => handleDelete(featuredApp.id)}
                  onToggleFavorite={() =>
                    handleToggleFavorite(featuredApp.id)
                  }
                  onOpen={() =>
                    handleOpen(
                      featuredApp.id,
                      featuredApp.title,
                      featuredApp.icon,
                    )
                  }
                  onRename={(title) => handleRename(featuredApp.id, title)}
                />
              </div>
            )}

            {/* All apps grid */}
            {remainingApps.length > 0 && (
              <div className="apps-view__section">
                <span className="apps-view__section-label">All Apps</span>
                <div className="apps-view__grid">
                  {remainingApps.map((app) => (
                    <AppCard
                      key={app.id}
                      artifact={app}
                      onDelete={() => handleDelete(app.id)}
                      onToggleFavorite={() => handleToggleFavorite(app.id)}
                      onOpen={() =>
                        handleOpen(app.id, app.title, app.icon)
                      }
                      onRename={(title) => handleRename(app.id, title)}
                    />
                  ))}
                </div>
              </div>
            )}
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
