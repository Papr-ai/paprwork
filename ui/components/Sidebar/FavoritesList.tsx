/**
 * FavoritesList - Collapsible favorites section with drag-and-drop support
 * Now uses SQLite for persistence (faster than localStorage)
 */

import React, { useState, useCallback } from "react";
import { useTabs } from "../../hooks/useTabs";
import { useArtifactsStore } from "../../stores/artifactsStore";
import { useTabStore } from "../../stores/tabStore";
import { gateway } from "../../src/lib/gateway";
import "./FavoritesList.css";

interface Favorite {
  id: string;
  type: "chat" | "document" | "app";
  title: string;
  icon?: string;
}

export function FavoritesList() {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isDragOver, setIsDragOver] = useState(false);
  const { createTab, switchToTab } = useTabs();
  const { artifacts } = useArtifactsStore();
  const { tabs } = useTabStore();

  // HYBRID APPROACH: Favorites from two sources
  // 1. Artifacts (document/app) - read from artifacts store (single source of truth)
  // 2. Non-artifacts (chat/jobs/settings) - read from tabs with isFavorite flag
  
  const artifactFavorites: Favorite[] = artifacts
    .filter(artifact => artifact.favorite)
    .map(artifact => ({
      id: artifact.id,
      type: artifact.type as "document" | "app",
      title: artifact.title,
      icon: artifact.icon,
    }));

  const nonArtifactFavorites: Favorite[] = tabs
    .filter(tab => 
      tab.isFavorite && 
      !['document', 'app', 'artifacts', 'documents', 'apps'].includes(tab.type)
    )
    .map(tab => ({
      id: tab.id,
      type: tab.type as "chat" | "document" | "app",
      title: tab.title,
      icon: tab.icon,
    }));

  const favorites: Favorite[] = [...artifactFavorites, ...nonArtifactFavorites];

  const toggleExpanded = () => {
    setIsExpanded(!isExpanded);
  };

  const removeFavorite = (id: string) => {
    const artifact = artifacts.find(a => a.id === id);
    
    if (artifact) {
      console.log(`[FavoritesList] Removing artifact favorite: ${id}`);
      const messageType = artifact.type === "document" ? "document:toggle-favorite" : "app:toggle-favorite";
      const payloadKey = artifact.type === "document" ? "documentId" : "appId";

      gateway.send(messageType, { [payloadKey]: id })
        .then((response) => {
          const updated = response.data as { favorite?: boolean };
          useArtifactsStore.getState().updateArtifact(id, { favorite: updated.favorite });
        })
        .catch((error: Error) => {
          console.error("[FavoritesList] Failed to unfavorite artifact:", error);
        });
    } else {
      console.log(`[FavoritesList] Removing tab favorite: ${id}`);
      const { tabs: currentTabs } = useTabStore.getState();
      const updatedTabs = currentTabs.map(t => 
        t.id === id ? { ...t, isFavorite: false } : t
      );
      useTabStore.setState({ tabs: updatedTabs });
      
      gateway.send('app:toggle_favorite_tab', { tabId: id }).catch((error: Error) => {
        console.error("Failed to remove favorite:", error);
      });
    }
  };

  const handleOpen = useCallback(
    (fav: Favorite) => {
      console.log(`[FavoritesList] Opening favorite: ${fav.id} (${fav.type})`);
      
      // Check if this is an artifact or a tab
      const artifact = artifacts.find(a => a.id === fav.id);
      
      if (artifact) {
        // Artifact - create tab using artifact ID
        const tabId = createTab(
          fav.type, 
          fav.id,  // Use artifact ID as entityId
          fav.title, 
          fav.icon ? { icon: fav.icon } : {}
        );
        switchToTab(tabId);
      } else {
        // Non-artifact tab - just switch to it
        const existingTab = tabs.find(t => t.id === fav.id);
        if (existingTab) {
          switchToTab(fav.id);
        } else {
          console.error(`[FavoritesList] Cannot open favorite ${fav.id} - not found`);
        }
      }
    },
    [artifacts, tabs, createTab, switchToTab],
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

      let raw = e.dataTransfer.getData("application/json");
      if (!raw) {
        raw = e.dataTransfer.getData("text/plain");
      }
      if (!raw) return;

      try {
        const data = JSON.parse(raw) as Record<string, unknown>;

        const entityId = (data.id ?? data.tabId) as string | undefined;
        const entityType = data.type as string | undefined;
        const entityTitle = data.title as string | undefined;

        if (!entityId || !entityType || !entityTitle) return;

        const validTypes: Favorite["type"][] = ["chat", "document", "app"];
        if (!validTypes.includes(entityType as Favorite["type"])) return;

        // Check if this is an artifact or a tab
        const artifact = artifacts.find(a => a.id === entityId);
        
        if (artifact) {
          if (artifact.favorite) {
            console.log(`[FavoritesList] Already favorited: ${entityId}`);
            return;
          }
          
          console.log(`[FavoritesList] Favoriting artifact via drag: ${entityId}`);
          const messageType = entityType === "document" ? "document:toggle-favorite" : "app:toggle-favorite";
          const payloadKey = entityType === "document" ? "documentId" : "appId";

          gateway.send(messageType, { [payloadKey]: entityId })
            .then((response) => {
              const updated = response.data as { favorite?: boolean };
              useArtifactsStore.getState().updateArtifact(entityId, { favorite: updated.favorite });
            })
            .catch((error: Error) => {
              console.error("[FavoritesList] Failed to favorite artifact:", error);
            });
        } else {
          console.log(`[FavoritesList] Favoriting tab via drag: ${entityId}`);
          const { tabs: currentTabs } = useTabStore.getState();
          
          const existingTab = currentTabs.find(t => t.id === entityId);
          if (existingTab?.isFavorite) {
            console.log(`[FavoritesList] Already favorited: ${entityId}`);
            return;
          }
          
          const updatedTabs = currentTabs.map(t => 
            t.id === entityId ? { ...t, isFavorite: true } : t
          );
          useTabStore.setState({ tabs: updatedTabs });
          
          gateway.send('app:toggle_favorite_tab', { tabId: entityId }).catch((error: Error) => {
            console.error("Failed to add favorite:", error);
          });
        }
      } catch {
        /* invalid drop data */
      }
    },
    [artifacts],
  );

  const getIcon = (favorite: Favorite) => {
    // App and document-type favorites: wrap icon in liquid glass orb (matches Tab.tsx)
    if (favorite.type === "app" || favorite.type === "document") {
      const innerIcon = favorite.icon ? (
        // Check if icon is SVG or emoji
        favorite.icon.trim().startsWith('<svg') || favorite.icon.trim().startsWith('<') ? (
          <span
            className="favorite-item__orb-icon"
            dangerouslySetInnerHTML={{ __html: favorite.icon }}
          />
        ) : (
          <span className="favorite-item__orb-icon" style={{ fontSize: '10px' }}>
            {favorite.icon}
          </span>
        )
      ) : favorite.type === "app" ? (
        <svg
          className="favorite-item__orb-icon"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
        >
          <defs>
            <linearGradient id="papr-blue-gradient-fav" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#00D4FF" />
              <stop offset="100%" stopColor="#0066FF" />
            </linearGradient>
          </defs>
          <rect x="3" y="3" width="7" height="7" rx="2" stroke="url(#papr-blue-gradient-fav)" strokeWidth="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="2" stroke="url(#papr-blue-gradient-fav)" strokeWidth="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="2" stroke="url(#papr-blue-gradient-fav)" strokeWidth="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="2" stroke="url(#papr-blue-gradient-fav)" strokeWidth="1.5" />
        </svg>
      ) : (
        <svg
          className="favorite-item__orb-icon"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
        >
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.5" />
          <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );

      return (
        <span className={`favorite-item__glass-orb ${favorite.type === "document" ? "favorite-item__glass-orb--document" : ""}`}>
          {innerIcon}
        </span>
      );
    }

    if (favorite.icon) {
      return <span dangerouslySetInnerHTML={{ __html: favorite.icon }} />;
    }

    const icons = {
      chat: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.5"/></svg>',
      document:
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="1.5"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.5"/></svg>',
    };

    return <span dangerouslySetInnerHTML={{ __html: icons[favorite.type] || icons.document }} />;
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
            <div className="favorites-list__empty">Drag your favorite app here</div>
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
