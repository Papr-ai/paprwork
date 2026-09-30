/**
 * DocumentCard - Document card with Liquid Glass orb icon (mirrors AppCard)
 */

import React, {
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
} from "react";
import type { Artifact } from "../../stores/artifactsStore";
import { markdownPreviewText } from "../../../src/core/utils/markdownPreview";
import "./DocumentCard.css";

interface DocumentCardProps {
  artifact: Artifact;
  featured?: boolean;
  onDelete: () => void;
  onToggleFavorite: () => void;
  onOpen: () => void;
  onRename?: (newTitle: string) => void;
  /** Omit to hide the archive action (e.g. surfaces that cannot restore). */
  onArchive?: (archived: boolean) => void;
}

export function DocumentCard({
  artifact,
  featured = false,
  onDelete,
  onToggleFavorite,
  onOpen,
  onRename,
  onArchive,
}: DocumentCardProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(artifact.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isArchived = artifact.archived === true;

  // Same dismissal contract as AppCard: any mousedown outside closes the menu.
  useEffect(() => {
    if (!menuOpen) return;
    const closeMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", closeMenu);
    return () => document.removeEventListener("mousedown", closeMenu);
  }, [menuOpen]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    return date.toLocaleDateString();
  };

  const startRename = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setIsEditing(true);
      setEditTitle(artifact.title);
      setTimeout(() => titleInputRef.current?.select(), 0);
    },
    [artifact.title],
  );

  const commitRename = useCallback(() => {
    setIsEditing(false);
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== artifact.title) {
      onRename?.(trimmed);
    }
  }, [editTitle, artifact.title, onRename]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitRename();
      } else if (e.key === "Escape") {
        setIsEditing(false);
        setEditTitle(artifact.title);
      }
    },
    [commitRename, artifact.title],
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(
        "application/json",
        JSON.stringify({
          id: artifact.id,
          type: artifact.type,
          title: artifact.title,
        }),
      );
      e.dataTransfer.effectAllowed = "copy";
    },
    [artifact.id, artifact.type, artifact.title],
  );

  const previewText = useMemo(
    () => (artifact.preview ? markdownPreviewText(artifact.preview) : ""),
    [artifact.preview],
  );

  const renderIcon = () => {
    // Document icon - matches Artifacts sidebar button
    return (
      <svg
        className="document-card__orb-icon"
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
      >
        <path
          d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M14 2v6h6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <line
          x1="8"
          y1="13"
          x2="16"
          y2="13"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line
          x1="8"
          y1="17"
          x2="13"
          y2="17"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  };

  return (
    <div
      className={`document-card ${featured ? "document-card--featured" : ""} ${isArchived ? "document-card--archived" : ""}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onOpen}
      draggable
      onDragStart={handleDragStart}
    >
      {/* Glass orb preview */}
      <div className="document-card__preview">
        <div className="document-card__orb">
          <div className="document-card__orb-inner">{renderIcon()}</div>
          <div className="document-card__orb-highlight" />
        </div>
      </div>

      {/* Content */}
      <div className="document-card__content">
        {isEditing ? (
          <input
            ref={titleInputRef}
            className="document-card__title-input"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleTitleKeyDown}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <h3
            className="document-card__title"
            onDoubleClick={startRename}
            title="Double-click to rename"
          >
            {artifact.title}
          </h3>
        )}
        {previewText && (
          <p className="document-card__preview-text">{previewText}</p>
        )}
        <div className="document-card__meta">
          {isArchived && (
            <>
              <span className="document-card__badge">Archived</span>
              <span className="document-card__meta-divider">•</span>
            </>
          )}
          <span className="document-card__date">{formatDate(artifact.updatedAt)}</span>
          {artifact.wordCount !== undefined && artifact.wordCount > 0 && (
            <>
              <span className="document-card__meta-divider">•</span>
              <span className="document-card__word-count">
                {artifact.wordCount.toLocaleString()} words
              </span>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <div
        className={`document-card__actions ${isHovered || menuOpen ? "document-card__actions--visible" : ""}`}
      >
        <button
          className={`document-card__action ${artifact.favorite ? "document-card__action--favorited" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
          aria-label="Toggle favorite"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill={artifact.favorite ? "currentColor" : "none"}
          >
            <path
              d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {/*
          Delete used to sit here as a bare one-click trash icon, directly
          beside the favourite star — an irreversible action one stray click
          away from a reversible one.

          It now lives behind the overflow menu together with Archive, which
          gives the destructive action a deliberate second step and puts the
          safe alternative next to it at the moment of choosing.

          Archived documents get exactly one status action, named after what
          the user is undoing ("Unarchive"), for the same reason AppCard does:
          "Mark as active" is technically correct and nobody reads it as the
          way back.
        */}
        <div className="document-card__menu-wrap" ref={menuRef}>
          <button
            className="document-card__action"
            aria-label={`More actions for ${artifact.title}`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((open) => !open);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
          </button>
          {menuOpen && (
            <div
              className="document-card__menu"
              role="menu"
              onClick={(e) => e.stopPropagation()}
            >
              {onArchive && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onArchive(!isArchived);
                  }}
                >
                  {isArchived ? "Unarchive" : "Archive"}
                </button>
              )}
              <button
                role="menuitem"
                className="document-card__menu-item--danger"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
