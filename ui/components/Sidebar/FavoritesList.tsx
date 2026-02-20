/**
 * FavoritesList - Collapsible favorites section with drag-and-drop support
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTabs } from "../../hooks/useTabs";
import "./FavoritesList.css";

interface Favorite {
  id: string;
  type: "chat" | "document" | "app";
  title: string;
  icon?: string;
}

export function FavoritesList() {
  const [isExpanded, setIsExpanded] = useState(true);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const { createTab, switchToTab } = useTabs();

  useEffect(() => {
    const stored = localStorage.getItem("paprwork-favorites");
    if (stored) {
      try {
        setFavorites(JSON.parse(stored));
      } catch (error) {
        console.error("Failed to load favorites:", error);
      }
    }
  }, []);

  const saveFavorites = useCallback((updated: Favorite[]) => {
    setFavorites(updated);
    localStorage.setItem("paprwork-favorites", JSON.stringify(updated));
  }, []);

  const toggleExpanded = () => {
    setIsExpanded(!isExpanded);
  };

  const removeFavorite = (id: string) => {
    saveFavorites(favorites.filter((f) => f.id !== id));
  };

  const handleOpen = useCallback(
    (fav: Favorite) => {
      const tabType =
        fav.type === "chat" ? "chat" : fav.type === "app" ? "app" : "document";
      const tabId = createTab(tabType, fav.id, fav.title);
      switchToTab(tabId);
    },
    [createTab, switchToTab],
  );

  // Drag-and-drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear drag-over when the cursor actually leaves the favorites area
    // (not when hovering child elements within the section)
    const current = e.currentTarget as HTMLElement;
    const related = e.relatedTarget as Node | null;
    if (!related || !current.contains(related)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      // Try application/json first (tab drag or artifact card drag)
      // then fall back to text/plain for legacy drag sources
      let raw = e.dataTransfer.getData("application/json");
      if (!raw) {
        raw = e.dataTransfer.getData("text/plain");
      }
      if (!raw) return;

      try {
        const data = JSON.parse(raw) as Record<string, unknown>;

        // Determine the entity id and type
        // Tab drag provides { id (entityId), type, title }
        // Artifact card drag provides { id, type, title, icon }
        const entityId = (data.id ?? data.tabId) as string | undefined;
        const entityType = data.type as string | undefined;
        const entityTitle = data.title as string | undefined;

        if (!entityId || !entityType || !entityTitle) return;

        // Accept chat, document, and app types
        const validTypes: Favorite["type"][] = ["chat", "document", "app"];
        if (!validTypes.includes(entityType as Favorite["type"])) return;

        // Don't add duplicates
        if (favorites.some((f) => f.id === entityId)) return;

        const newFav: Favorite = {
          id: entityId,
          type: entityType as Favorite["type"],
          title: entityTitle,
          icon: typeof data.icon === "string" ? data.icon : undefined,
        };

        saveFavorites([...favorites, newFav]);
      } catch {
        /* invalid drop data */
      }
    },
    [favorites, saveFavorites],
  );

  const getIcon = (favorite: Favorite) => {
    if (favorite.icon) {
      return <span dangerouslySetInnerHTML={{ __html: favorite.icon }} />;
    }

    const icons = {
      chat: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.5"/></svg>',
      document:
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="1.5"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.5"/></svg>',
      app: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>',
    };

    return <span dangerouslySetInnerHTML={{ __html: icons[favorite.type] }} />;
  };

  return (
    <div
      className={`favorites-list${isDragOver ? " favorites-list--drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <button className="favorites-list__header" onClick={toggleExpanded}>
        <svg
          className={`favorites-list__chevron ${isExpanded ? "favorites-list__chevron--expanded" : ""}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
        >
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="favorites-list__title">Favorites</span>
        <span className="favorites-list__count">{favorites.length}</span>
      </button>
      {isExpanded && (
        <div className="favorites-list__items">
          {favorites.length === 0 && (
            <div className="favorites-list__empty">Drag artifacts here</div>
          )}
          {favorites.map((favorite) => (
            <div
              key={favorite.id}
              className="favorite-item"
              onClick={() => handleOpen(favorite)}
            >
              <span className="favorite-item__icon">{getIcon(favorite)}</span>
              <span className="favorite-item__title">{favorite.title}</span>
              <button
                className="favorite-item__remove"
                onClick={(e) => {
                  e.stopPropagation();
                  removeFavorite(favorite.id);
                }}
                aria-label="Remove favorite"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
