/**
 * AppCard - Wabi-inspired app card with Liquid Glass orb icon
 */

import React, { useState, useRef, useCallback, useEffect } from "react";
import type { Artifact } from "../../stores/artifactsStore";
import "./AppCard.css";

type AppStatus = "draft" | "active" | "archived";

interface AppCardProps {
  artifact: Artifact;
  featured?: boolean;
  compact?: boolean;
  onDelete: () => void;
  onToggleFavorite: () => void;
  onOpen: () => void;
  onRename?: (newTitle: string) => void;
  onSetStatus?: (status: AppStatus) => void;
  /** App is live on apps.papr.ai (from cloud publish snapshot). */
  isPublished?: boolean;
  /** Show "Copy to namespace" when logged into Papr with multiple namespaces. */
  showCopyAction?: boolean;
  onCopy?: () => void;
}

export function AppCard({
  artifact,
  featured = false,
  compact = false,
  onDelete,
  onToggleFavorite,
  onOpen,
  onRename,
  onSetStatus,
  isPublished = false,
  showCopyAction = false,
  onCopy,
}: AppCardProps) {
  const status: AppStatus = artifact.status ?? "active";
  const [menuOpen, setMenuOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(artifact.title);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
          ...(artifact.icon ? { icon: artifact.icon } : {}),
        }),
      );
      e.dataTransfer.effectAllowed = "copy";
    },
    [artifact.id, artifact.type, artifact.title, artifact.icon],
  );

  const isImageIcon = (icon: string) =>
    icon.startsWith("data:image/") || icon.startsWith("http");

  const renderIcon = () => {
    if (artifact.icon) {
      const trimmedIcon = artifact.icon.trim();

      // Full droplet renders (512×512 PNG) — orb shell is hidden; image carries the glass sphere
      if (isImageIcon(artifact.icon)) {
        return (
          <img
            className="app-card__orb-icon app-card__orb-icon--image"
            src={artifact.icon}
            alt={artifact.title}
            draggable={false}
          />
        );
      }

      // Inline SVG markup
      if (trimmedIcon.startsWith("<svg") || trimmedIcon.startsWith("<")) {
        return (
          <span
            className="app-card__orb-icon"
            dangerouslySetInnerHTML={{ __html: artifact.icon }}
          />
        );
      }

      // Check if it's a valid emoji (Unicode character, not plain ASCII text)
      // Emojis are typically > 1 byte when encoded
      const isEmoji =
        trimmedIcon.length <= 4 && /[\p{Emoji}]/u.test(trimmedIcon);

      if (isEmoji) {
        return (
          <span className="app-card__orb-icon" style={{ fontSize: "28px" }}>
            {artifact.icon}
          </span>
        );
      }

      // Plain text strings like "chart", "shield" - treat as missing icon
      console.warn(
        `App "${artifact.title}" has invalid icon: "${artifact.icon}". Expected SVG markup or emoji.`,
      );
    }

    // Default four-square grid icon for apps without custom icons or invalid icons
    return (
      <svg
        className="app-card__orb-icon"
        width="44"
        height="44"
        viewBox="0 0 24 24"
        fill="none"
      >
        <defs>
          <linearGradient
            id="papr-blue-gradient"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop offset="0%" stopColor="#00D4FF" />
            <stop offset="100%" stopColor="#0066FF" />
          </linearGradient>
        </defs>
        <rect
          x="3"
          y="3"
          width="7"
          height="7"
          rx="2"
          stroke="url(#papr-blue-gradient)"
          strokeWidth="1.5"
        />
        <rect
          x="14"
          y="3"
          width="7"
          height="7"
          rx="2"
          stroke="url(#papr-blue-gradient)"
          strokeWidth="1.5"
        />
        <rect
          x="3"
          y="14"
          width="7"
          height="7"
          rx="2"
          stroke="url(#papr-blue-gradient)"
          strokeWidth="1.5"
        />
        <rect
          x="14"
          y="14"
          width="7"
          height="7"
          rx="2"
          stroke="url(#papr-blue-gradient)"
          strokeWidth="1.5"
        />
      </svg>
    );
  };

  return (
    <div
      className={`app-card ${featured ? "app-card--featured" : ""} ${compact ? "app-card--compact" : ""}`}
      onClick={onOpen}
      draggable
      onDragStart={handleDragStart}
    >
      <div className="app-card__preview">
        {artifact.preview &&
        /^(data:image\/|https?:\/\/)/.test(artifact.preview) ? (
          <img
            className="app-card__screenshot"
            src={artifact.preview}
            alt={`${artifact.title} preview`}
            draggable={false}
          />
        ) : (
          <div className="app-card__orb">
            <div className="app-card__orb-inner">{renderIcon()}</div>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="app-card__content">
        {isEditing ? (
          <input
            ref={titleInputRef}
            className="app-card__title-input"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleTitleKeyDown}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <div className="app-card__title-row">
            <h3
              className="app-card__title"
              onDoubleClick={startRename}
              title="Double-click to rename"
            >
              {artifact.title}
            </h3>
            {artifact.cloudLineage ? (
              <span
                className={
                  artifact.cloudLineage.mode === "track"
                    ? "app-card__cloud-badge app-card__cloud-badge--track"
                    : "app-card__cloud-badge app-card__cloud-badge--fork"
                }
                title={`From cloud: ${artifact.cloudLineage.sourceSlug}`}
              >
                {artifact.cloudLineage.mode === "track" ? "Track" : "Fork"}
              </span>
            ) : null}
            {isPublished && (
              <span
                className="app-card__status-badge app-card__status-badge--published"
                title="Live on apps.papr.ai"
              >
                Live
              </span>
            )}
            {status !== "active" && !(isPublished && status === "draft") && (
              <span
                className={`app-card__status-badge app-card__status-badge--${status}`}
                title={status === "draft" ? "Draft app" : "Archived app"}
              >
                {status === "draft" ? "Draft" : "Archived"}
              </span>
            )}
          </div>
        )}
        {artifact.description && (
          <p className="app-card__description">{artifact.description}</p>
        )}
        <span className="app-card__date">
          {artifact.lastOpenedAt
            ? `Opened ${formatDate(artifact.lastOpenedAt).toLowerCase()}`
            : formatDate(artifact.updatedAt)}
        </span>
      </div>

      <div className="app-card__menu-wrap" ref={menuRef}>
        <button
          className="app-card__menu-trigger"
          aria-label={`Actions for ${artifact.title}`}
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          }}
        >
          <span>•••</span>
        </button>
        {menuOpen && (
          <div
            className="app-card__menu"
            role="menu"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpen();
              }}
            >
              Open
            </button>
            <button
              role="menuitem"
              onClick={(e) => {
                setMenuOpen(false);
                startRename(e);
              }}
            >
              Rename
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onToggleFavorite();
              }}
            >
              {artifact.favorite ? "Remove from favorites" : "Add to favorites"}
            </button>
            {onSetStatus && status !== "draft" && !isPublished && (
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onSetStatus("draft");
                }}
              >
                Mark as draft
              </button>
            )}
            {onSetStatus && status !== "active" && (
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onSetStatus("active");
                }}
              >
                Mark as active
              </button>
            )}
            {onSetStatus && status !== "archived" && (
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onSetStatus("archived");
                }}
              >
                Archive
              </button>
            )}
            {showCopyAction && onCopy && (
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onCopy();
                }}
              >
                Copy to workspace…
              </button>
            )}
            <div className="app-card__menu-separator" />
            <button
              className="app-card__menu-danger"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
            >
              Delete app
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
