/**
 * ArtifactsView - Gallery view for documents and apps
 * Features: favorites filter, sort, grid/list toggle, new document creation
 */

import React, { useState, useCallback } from "react";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useTabs } from "../../hooks/useTabs";
import { gateway } from "../../src/lib/gateway";
import { ArtifactCard } from "./ArtifactCard";
import type { Artifact, ArtifactType } from "../../stores/artifactsStore";
import "./ArtifactsView.css";

type SortOption = "recent" | "oldest" | "name-asc" | "name-desc";
type ViewMode = "grid" | "list";

export function ArtifactsView() {
  const showTemplateShortcut =
    import.meta.env.VITE_ENABLE_PIPELINE_TEMPLATE_SHORTCUT === "true";
  const {
    filteredArtifacts,
    loading,
    error,
    filter,
    searchQuery,
    setFilter,
    setSearchQuery,
    deleteArtifact,
    toggleFavorite,
    createDocument,
    createApp,
    loadArtifacts,
  } = useArtifacts();
  const { createTab, switchToTab } = useTabs();

  const [view, setView] = useState<"documents" | "apps">("documents");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [newAppTitle, setNewAppTitle] = useState("");
  const [newAppDescription, setNewAppDescription] = useState("");
  const [showNewDocInput, setShowNewDocInput] = useState(false);
  const [newDocTitle, setNewDocTitle] = useState("");

  const handleFilterChange = (newFilter: ArtifactType | "all") => {
    setFilter(newFilter);
  };

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };

  const handleDelete = async (id: string, type: ArtifactType) => {
    if (confirm(`Are you sure you want to delete this ${type}?`)) {
      await deleteArtifact(id, type);
    }
  };

  const handleToggleFavorite = async (id: string, type: ArtifactType) => {
    await toggleFavorite(id, type);
  };

  const handleOpen = (id: string, type: ArtifactType, title: string, icon?: string) => {
    const tabType = type === "app" ? "app" : "document";
    const tabId = createTab(tabType, id, title, icon ? { icon } : {});
    switchToTab(tabId);
  };

  const handleRename = useCallback(
    async (id: string, type: ArtifactType, newTitle: string) => {
      const msgType = type === "document" ? "document:update" : "app:update";
      const payloadKey = type === "document" ? "documentId" : "appId";
      await gateway.send(msgType, { [payloadKey]: id, title: newTitle });
      loadArtifacts();
    },
    [loadArtifacts],
  );

  const handleCreateDoc = useCallback(async () => {
    const title = newDocTitle.trim() || "Untitled Document";
    const doc = await createDocument(title);
    if (doc) {
      setNewDocTitle("");
      setShowNewDocInput(false);
      handleOpen(doc.id, "document", doc.title);
    }
  }, [newDocTitle, createDocument]);

  const handleCreateApp = async () => {
    if (!newAppTitle.trim()) return;
    const app = await createApp(
      newAppTitle.trim(),
      newAppDescription.trim() || "Generated mini app",
      [
        {
          filename: "index.html",
          content: `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${newAppTitle.trim()}</title>
    <style>
      body { font-family: -apple-system, sans-serif; margin: 24px; color: #1d1d1f; }
      h1 { margin: 0 0 12px; }
    </style>
  </head>
  <body>
    <h1>${newAppTitle.trim()}</h1>
    <p>${newAppDescription.trim() || "New Papr mini-app"}</p>
  </body>
</html>`,
        },
      ],
    );
    if (app) {
      setNewAppTitle("");
      setNewAppDescription("");
      handleOpen(app.id, "app", app.title);
    }
  };

  const handleCreatePipelineTemplate = async () => {
    const pipelineName = newAppTitle.trim() || "Pipeline Template";
    const response = await gateway.send("template:create-pipeline", {
      name: pipelineName,
      description: newAppDescription.trim() || undefined,
    });
    const data = response.data as { app?: { id: string; title: string } };
    if (data?.app) {
      setNewAppTitle("");
      setNewAppDescription("");
      handleOpen(data.app.id, "app", data.app.title);
    }
  };

  // Filter by view tab + favorites
  let viewArtifacts = filteredArtifacts.filter((a) => {
    if (view === "documents") return a.type === "document";
    if (view === "apps") return a.type === "app";
    return true;
  });

  if (showFavoritesOnly) {
    viewArtifacts = viewArtifacts.filter((a) => a.favorite);
  }

  // Sort
  viewArtifacts = [...viewArtifacts].sort((a, b) => {
    switch (sortBy) {
      case "oldest":
        return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      case "name-asc":
        return a.title.localeCompare(b.title);
      case "name-desc":
        return b.title.localeCompare(a.title);
      case "recent":
      default:
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    }
  });

  return (
    <div className="artifacts-view">
      {/* Header */}
      <div className="artifacts-view__header">
        <h2 className="artifacts-view__title">Artifacts</h2>

        <div className="artifacts-view__tabs">
          <button
            className={`artifacts-view__tab ${view === "documents" ? "artifacts-view__tab--active" : ""}`}
            onClick={() => setView("documents")}
          >
            Documents
          </button>
          <button
            className={`artifacts-view__tab ${view === "apps" ? "artifacts-view__tab--active" : ""}`}
            onClick={() => setView("apps")}
          >
            Apps
          </button>
        </div>
      </div>

      {/* Controls row */}
      <div className="artifacts-view__controls">
        <div className="artifacts-view__controls-left">
          <input
            type="text"
            className="artifacts-view__search"
            placeholder="Search artifacts..."
            value={searchQuery}
            onChange={handleSearch}
          />

          <button
            className={`artifacts-view__icon-btn ${showFavoritesOnly ? "artifacts-view__icon-btn--active" : ""}`}
            onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
            title="Show favorites only"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill={showFavoritesOnly ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
          </button>

          <select
            className="artifacts-view__sort"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
          >
            <option value="recent">Recent</option>
            <option value="oldest">Oldest</option>
            <option value="name-asc">Name A-Z</option>
            <option value="name-desc">Name Z-A</option>
          </select>
        </div>

        <div className="artifacts-view__controls-right">
          <button
            className={`artifacts-view__icon-btn ${viewMode === "grid" ? "artifacts-view__icon-btn--active" : ""}`}
            onClick={() => setViewMode("grid")}
            title="Grid view"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </button>
          <button
            className={`artifacts-view__icon-btn ${viewMode === "list" ? "artifacts-view__icon-btn--active" : ""}`}
            onClick={() => setViewMode("list")}
            title="List view"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>

          {view === "documents" && (
            <button
              className="artifacts-view__new-btn"
              onClick={() => setShowNewDocInput(!showNewDocInput)}
            >
              + New Document
            </button>
          )}
        </div>
      </div>

      {/* New document input */}
      {showNewDocInput && view === "documents" && (
        <div className="artifacts-view__new-doc">
          <input
            type="text"
            className="artifacts-view__search"
            placeholder="Document title..."
            value={newDocTitle}
            onChange={(e) => setNewDocTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateDoc();
              if (e.key === "Escape") setShowNewDocInput(false);
            }}
            autoFocus
          />
          <button className="filter-pill filter-pill--active" onClick={() => void handleCreateDoc()}>
            Create
          </button>
        </div>
      )}

      {view === "apps" && (
        <div className="artifacts-view__filters">
          <input
            type="text"
            className="artifacts-view__search"
            placeholder="New app title..."
            value={newAppTitle}
            onChange={(event) => setNewAppTitle(event.target.value)}
          />
          <input
            type="text"
            className="artifacts-view__search"
            placeholder="Description (optional)"
            value={newAppDescription}
            onChange={(event) => setNewAppDescription(event.target.value)}
          />
          <button className="filter-pill filter-pill--active" onClick={() => void handleCreateApp()}>
            Create App
          </button>
          {showTemplateShortcut && (
            <button
              className="filter-pill"
              onClick={() => void handleCreatePipelineTemplate()}
            >
              Create Pipeline Template
            </button>
          )}
        </div>
      )}

      {/* Content */}
      <div className="artifacts-view__content">
        {loading && (
          <div className="artifacts-view__loading">Loading artifacts...</div>
        )}

        {error && (
          <div className="artifacts-view__error">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              opacity="0.4"
            >
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
              <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <p>{error}</p>
            <button className="artifacts-view__retry-btn" onClick={loadArtifacts}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && viewArtifacts.length === 0 && (
          <div className="artifacts-view__empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" opacity="0.3">
              {view === "documents" ? (
                <>
                  <path
                    d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" />
                </>
              ) : (
                <>
                  <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
                  <line x1="3" y1="9" x2="21" y2="9" stroke="currentColor" strokeWidth="1.5" />
                  <line x1="9" y1="21" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" />
                </>
              )}
            </svg>
            <p className="artifacts-view__empty-title">
              {showFavoritesOnly
                ? "No favorited artifacts"
                : `No ${view === "documents" ? "documents" : "apps"} yet`}
            </p>
            <p className="artifacts-view__empty-subtitle">
              {showFavoritesOnly
                ? "Star your favorite artifacts to see them here."
                : view === "documents"
                  ? "Create a document above or ask the agent to write one for you."
                  : "Create an app above or ask the agent to build one for you."}
            </p>
          </div>
        )}

        {!loading && !error && viewArtifacts.length > 0 && (
          <div
            className={
              viewMode === "grid"
                ? "artifacts-view__grid"
                : "artifacts-view__list"
            }
          >
            {viewArtifacts.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                artifact={artifact}
                viewMode={viewMode}
                onDelete={() => handleDelete(artifact.id, artifact.type)}
                onToggleFavorite={() =>
                  handleToggleFavorite(artifact.id, artifact.type)
                }
                onOpen={() =>
                  handleOpen(artifact.id, artifact.type, artifact.title, artifact.icon)
                }
                onRename={(title) =>
                  handleRename(artifact.id, artifact.type, title)
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
