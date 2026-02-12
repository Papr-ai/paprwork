/**
 * ArtifactsView - Gallery view for documents and apps
 * Reference: Paprwork v1 app.js lines 14221-14406
 */

import React, { useState } from "react";
import { useArtifacts } from "../../hooks/useArtifacts";
import { ArtifactCard } from "./ArtifactCard";
import type { ArtifactType } from "../../stores/artifactsStore";
import "./ArtifactsView.css";

export function ArtifactsView() {
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
  } = useArtifacts();

  const [view, setView] = useState<"documents" | "apps">("documents");

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

  // Filter by view tab
  const viewArtifacts = filteredArtifacts.filter((a) => {
    if (view === "documents") return a.type === "document";
    if (view === "apps") return a.type === "app";
    return true;
  });

  return (
    <div className="artifacts-view">
      {/* Header */}
      <div className="artifacts-view__header">
        <h2 className="artifacts-view__title">Artifacts</h2>

        {/* View tabs */}
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

      {/* Filters */}
      <div className="artifacts-view__filters">
        <div className="artifacts-view__filter-pills">
          <button
            className={`filter-pill ${filter === "all" ? "filter-pill--active" : ""}`}
            onClick={() => handleFilterChange("all")}
          >
            All
          </button>
          <button
            className={`filter-pill ${filter === "document" ? "filter-pill--active" : ""}`}
            onClick={() => handleFilterChange("document")}
          >
            Documents
          </button>
          <button
            className={`filter-pill ${filter === "app" ? "filter-pill--active" : ""}`}
            onClick={() => handleFilterChange("app")}
          >
            Apps
          </button>
        </div>

        <input
          type="text"
          className="artifacts-view__search"
          placeholder="Search artifacts..."
          value={searchQuery}
          onChange={handleSearch}
        />
      </div>

      {/* Content */}
      <div className="artifacts-view__content">
        {loading && (
          <div className="artifacts-view__loading">Loading artifacts...</div>
        )}

        {error && <div className="artifacts-view__error">{error}</div>}

        {!loading && !error && viewArtifacts.length === 0 && (
          <div className="artifacts-view__empty">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              opacity="0.3"
            >
              <path
                d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <p>No {view === "documents" ? "documents" : "apps"} yet</p>
          </div>
        )}

        {!loading && !error && viewArtifacts.length > 0 && (
          <div className="artifacts-view__grid">
            {viewArtifacts.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                artifact={artifact}
                onDelete={() => handleDelete(artifact.id, artifact.type)}
                onToggleFavorite={() =>
                  handleToggleFavorite(artifact.id, artifact.type)
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
