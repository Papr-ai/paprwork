/**
 * AppsView - Wabi-inspired app gallery with Liquid Glass design
 * Clean, minimal interface focused on app discovery and creation
 */

import React, { useState, useCallback, useMemo } from "react";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useTabs } from "../../hooks/useTabs";
import { gateway } from "../../src/lib/gateway";
import { AppCard } from "./AppCard";
import type { Artifact } from "../../stores/artifactsStore";
import "./AppsView.css";

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
    createApp,
    loadArtifacts,
  } = useArtifacts();
  const { createTab, switchToTab } = useTabs();

  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [newAppTitle, setNewAppTitle] = useState("");

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

  const handleCreateApp = async () => {
    const title = newAppTitle.trim();
    if (!title) return;

    const app = await createApp(
      title,
      "Generated mini app",
      [
        {
          filename: "index.html",
          content: `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, sans-serif; margin: 24px; color: #1d1d1f; }
      h1 { margin: 0 0 12px; }
    </style>
  </head>
  <body>
    <h1>${title}</h1>
    <p>New Papr mini-app</p>
  </body>
</html>`,
        },
      ],
    );
    if (app) {
      setNewAppTitle("");
      handleOpen(app.id, app.title);
    }
  };

  // Filter to apps only, then sort
  const apps = useMemo(() => {
    let result = filteredArtifacts.filter((a) => a.type === "app");

    switch (sortBy) {
      case "name":
        result = [...result].sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "favorites":
        result = [...result].sort((a, b) => {
          if (a.favorite && !b.favorite) return -1;
          if (!a.favorite && b.favorite) return 1;
          return (
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          );
        });
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

        <div className="apps-view__header-actions">
          <input
            type="text"
            className="apps-view__search"
            placeholder="Search apps..."
            value={searchQuery}
            onChange={handleSearch}
          />
        </div>
      </div>

      {/* Create bar */}
      <div className="apps-view__create">
        <input
          type="text"
          className="apps-view__create-input"
          placeholder="New app name..."
          value={newAppTitle}
          onChange={(e) => setNewAppTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreateApp();
          }}
        />
        <button
          className="apps-view__create-btn"
          onClick={() => void handleCreateApp()}
          disabled={!newAppTitle.trim()}
        >
          Create
        </button>
      </div>

      {/* Sort controls */}
      <div className="apps-view__controls">
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
            <button className="apps-view__create-btn" onClick={loadArtifacts}>
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
              Ask the AI to build one for you, or create one above.
            </p>
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
    </div>
  );
}
