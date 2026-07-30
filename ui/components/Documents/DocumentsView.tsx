/**
 * DocumentsView - Document gallery with Liquid Glass design (mirrors AppsView)
 * Clean, minimal interface focused on document discovery and creation
 */

import React, { useState, useCallback, useMemo } from "react";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useTabs } from "../../hooks/useTabs";
import { gateway } from "../../src/lib/gateway";
import { DocumentCard } from "./DocumentCard";
import type { Artifact } from "../../stores/artifactsStore";
import "./DocumentsView.css";

type SortOption = "recent" | "name" | "favorites";

export function DocumentsView() {
  const {
    filteredArtifacts,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    deleteArtifact,
    toggleFavorite,
    createDocument,
    loadArtifacts,
  } = useArtifacts();
  const { createTab, switchToTab } = useTabs();

  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [newDocTitle, setNewDocTitle] = useState("");

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };

  const handleDelete = async (id: string) => {
    if (confirm("Are you sure you want to delete this document?")) {
      await deleteArtifact(id, "document");
    }
  };

  const handleToggleFavorite = async (id: string) => {
    await toggleFavorite(id, "document");
  };

  const handleOpen = (id: string, title: string) => {
    const tabId = createTab("document", id, title);
    switchToTab(tabId);
  };

  const handleRename = useCallback(
    async (id: string, newTitle: string) => {
      await gateway.send("document:update", { documentId: id, title: newTitle });
      loadArtifacts();
    },
    [loadArtifacts],
  );

  const handleCreateDocument = async () => {
    const title = newDocTitle.trim();
    if (!title) return;

    const doc = await createDocument(title, "");
    if (doc) {
      setNewDocTitle("");
      handleOpen(doc.id, doc.title);
    }
  };

  // Filter to documents only, then sort/filter
  const documents = useMemo(() => {
    let result = filteredArtifacts.filter((a) => a.type === "document");

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

  // Featured document: most recent favorited, or just most recent
  const featuredDocument = useMemo(() => {
    if (documents.length === 0) return null;
    const favorited = documents.find((d) => d.favorite);
    return favorited || documents[0];
  }, [documents]);

  const remainingDocuments = useMemo(
    () => (featuredDocument ? documents.filter((d) => d.id !== featuredDocument.id) : documents),
    [documents, featuredDocument],
  );

  return (
    <div className="documents-view">
      {/* Header */}
      <div className="documents-view__header">
        <h2 className="documents-view__title">Documents</h2>

        <div className="documents-view__header-actions">
          <input
            type="text"
            className="documents-view__search"
            placeholder="Search documents..."
            value={searchQuery}
            onChange={handleSearch}
          />
        </div>
      </div>

      {/* Create bar */}
      <div className="documents-view__create">
        <input
          type="text"
          className="documents-view__create-input"
          placeholder="New document name..."
          value={newDocTitle}
          onChange={(e) => setNewDocTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreateDocument();
          }}
        />
        <button
          className="documents-view__create-btn"
          onClick={() => void handleCreateDocument()}
          disabled={!newDocTitle.trim()}
        >
          Create
        </button>
      </div>

      {/* Sort controls */}
      <div className="documents-view__controls">
        <div className="documents-view__sort">
          {(["recent", "name", "favorites"] as SortOption[]).map((option) => (
            <button
              key={option}
              className={`documents-view__sort-btn ${sortBy === option ? "documents-view__sort-btn--active" : ""}`}
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
      <div className="documents-view__content">
        {loading && (
          <div className="documents-view__empty">
            <p>Loading documents...</p>
          </div>
        )}

        {error && (
          <div className="documents-view__empty">
            <p style={{ color: "var(--error)" }}>{error}</p>
            <button className="documents-view__create-btn" onClick={loadArtifacts}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && documents.length === 0 && (
          <div className="documents-view__empty">
            <svg
              width="64"
              height="64"
              viewBox="0 0 24 24"
              fill="none"
              opacity="0.2"
            >
              <path
                d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" />
              <line x1="8" y1="13" x2="16" y2="13" stroke="currentColor" strokeWidth="1.5" />
              <line x1="8" y1="17" x2="16" y2="17" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <p className="documents-view__empty-title">No documents yet</p>
            <p className="documents-view__empty-subtitle">
              Ask the AI to create one for you, or create one above.
            </p>
          </div>
        )}

        {!loading && !error && documents.length > 0 && (
          <>
            {/* Featured document */}
            {featuredDocument && (
              <div className="documents-view__featured">
                <span className="documents-view__section-label">Featured</span>
                <DocumentCard
                  artifact={featuredDocument}
                  featured
                  onDelete={() => handleDelete(featuredDocument.id)}
                  onToggleFavorite={() =>
                    handleToggleFavorite(featuredDocument.id)
                  }
                  onOpen={() =>
                    handleOpen(
                      featuredDocument.id,
                      featuredDocument.title,
                    )
                  }
                  onRename={(title) => handleRename(featuredDocument.id, title)}
                />
              </div>
            )}

            {/* All documents grid */}
            {remainingDocuments.length > 0 && (
              <div className="documents-view__section">
                <span className="documents-view__section-label">All Documents</span>
                <div className="documents-view__grid">
                  {remainingDocuments.map((doc) => (
                    <DocumentCard
                      key={doc.id}
                      artifact={doc}
                      onDelete={() => handleDelete(doc.id)}
                      onToggleFavorite={() => handleToggleFavorite(doc.id)}
                      onOpen={() =>
                        handleOpen(doc.id, doc.title)
                      }
                      onRename={(title) => handleRename(doc.id, title)}
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
