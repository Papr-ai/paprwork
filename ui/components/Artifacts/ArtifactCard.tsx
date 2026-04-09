/**
 * ArtifactCard - Individual artifact card with preview, word count, inline rename, drag support
 */

import React, { useState, useRef, useCallback } from "react";
import { artifactTypeLabel, type Artifact } from "../../stores/artifactsStore";
import "./ArtifactCard.css";

interface ArtifactCardProps {
  artifact: Artifact;
  viewMode?: "grid" | "list";
  onDelete: () => void;
  onToggleFavorite: () => void;
  onOpen: () => void;
  onRename?: (newTitle: string) => void;
}

export function ArtifactCard({
  artifact,
  viewMode = "grid",
  onDelete,
  onToggleFavorite,
  onOpen,
  onRename,
}: ArtifactCardProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(artifact.title);
  const titleInputRef = useRef<HTMLInputElement>(null);

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

  // Drag support for favorites
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(
        "application/json",
        JSON.stringify({
          id: artifact.id,
          type: artifact.type,
          title: artifact.title,
          ...(artifact.icon ? { icon: artifact.icon } : {}),
        }),
      );
      e.dataTransfer.effectAllowed = "copy";
    },
    [artifact.id, artifact.type, artifact.title, artifact.icon],
  );

  const getIcon = () => {
    if (artifact.icon) {
      // Image-based icon (droplet style PNG/data URI)
      if (artifact.icon.startsWith("data:image/") || artifact.icon.startsWith("http")) {
        return <img src={artifact.icon} alt={artifact.title} style={{ width: 24, height: 24, borderRadius: "50%", objectFit: "cover" }} draggable={false} />;
      }
      return <span dangerouslySetInnerHTML={{ __html: artifact.icon }} />;
    }

    if (artifact.type === "document") {
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path
            d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    }

    if (artifact.type === "file") {
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path
            d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M14 2v6h6M9 15h6M9 11h6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    }

    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <rect
          x="3"
          y="3"
          width="7"
          height="7"
          rx="1"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <rect
          x="14"
          y="3"
          width="7"
          height="7"
          rx="1"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <rect
          x="3"
          y="14"
          width="7"
          height="7"
          rx="1"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <rect
          x="14"
          y="14"
          width="7"
          height="7"
          rx="1"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    );
  };

  const previewLines = artifact.preview ? artifact.preview.slice(0, 120) : "";

  return (
    <div
      className={`artifact-card artifact-card--${viewMode}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onOpen}
      draggable
      onDragStart={handleDragStart}
    >
      {/* Preview */}
      <div className="artifact-card__preview">
        {previewLines ? (
          <div className="artifact-card__preview-text">{previewLines}</div>
        ) : (
          <div className="artifact-card__preview-icon">{getIcon()}</div>
        )}
      </div>

      {/* Content */}
      <div className="artifact-card__content">
        {isEditing ? (
          <input
            ref={titleInputRef}
            className="artifact-card__title-input"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleTitleKeyDown}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <h3
            className="artifact-card__title"
            onDoubleClick={startRename}
            title="Double-click to rename"
          >
            {artifact.title}
          </h3>
        )}
        <div className="artifact-card__meta">
          <span className="artifact-card__type">
            {artifactTypeLabel(artifact.type)}
          </span>
          {artifact.wordCount !== undefined && artifact.wordCount > 0 && (
            <span className="artifact-card__word-count">
              {artifact.wordCount.toLocaleString()} words
            </span>
          )}
          <span className="artifact-card__date">
            {formatDate(artifact.updatedAt)}
          </span>
        </div>
        {artifact.tags && artifact.tags.length > 0 && (
          <div className="artifact-card__tags">
            {artifact.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="artifact-card__tag">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div
        className={`artifact-card__actions ${isHovered ? "artifact-card__actions--visible" : ""}`}
      >
        <button
          className={`artifact-card__action artifact-card__action--favorite ${artifact.favorite ? "artifact-card__action--active" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
          aria-label="Toggle favorite"
        >
          <svg
            width="18"
            height="18"
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
        <button
          className="artifact-card__action artifact-card__action--delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
