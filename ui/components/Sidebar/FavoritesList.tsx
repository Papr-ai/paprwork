/**
 * FavoritesList - Collapsible favorites section
 */

import React, { useState, useEffect } from "react";
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

  useEffect(() => {
    // Load favorites from localStorage
    const stored = localStorage.getItem("paprwork-favorites");
    if (stored) {
      try {
        setFavorites(JSON.parse(stored));
      } catch (error) {
        console.error("Failed to load favorites:", error);
      }
    }
  }, []);

  const toggleExpanded = () => {
    setIsExpanded(!isExpanded);
  };

  const removeFavorite = (id: string) => {
    const updated = favorites.filter((f) => f.id !== id);
    setFavorites(updated);
    localStorage.setItem("paprwork-favorites", JSON.stringify(updated));
  };

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

  if (favorites.length === 0) {
    return null;
  }

  return (
    <div className="favorites-list">
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
      </button>
      {isExpanded && (
        <div className="favorites-list__items">
          {favorites.map((favorite) => (
            <div key={favorite.id} className="favorite-item">
              <span className="favorite-item__icon">{getIcon(favorite)}</span>
              <span className="favorite-item__title">{favorite.title}</span>
              <button
                className="favorite-item__remove"
                onClick={() => removeFavorite(favorite.id)}
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
