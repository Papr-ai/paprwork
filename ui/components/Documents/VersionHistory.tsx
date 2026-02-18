/**
 * VersionHistory - Slide-out panel showing document version history
 */

import React, { useState, useCallback } from "react";
import type {
  DocumentVersion,
  DocumentVersionFull,
} from "../../hooks/useDocuments";
import "./VersionHistory.css";

interface VersionHistoryProps {
  versions: DocumentVersion[];
  onGetVersion: (versionId: string) => Promise<DocumentVersionFull | null>;
  onRestore: (versionId: string) => void;
  onClose: () => void;
}

export function VersionHistory({
  versions,
  onGetVersion,
  onRestore,
  onClose,
}: VersionHistoryProps) {
  const [previewVersion, setPreviewVersion] =
    useState<DocumentVersionFull | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const handlePreview = useCallback(
    async (versionId: string) => {
      setLoadingId(versionId);
      const full = await onGetVersion(versionId);
      setPreviewVersion(full);
      setLoadingId(null);
    },
    [onGetVersion],
  );

  const handleRestore = useCallback(
    (versionId: string) => {
      onRestore(versionId);
      setPreviewVersion(null);
    },
    [onRestore],
  );

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  };

  const reasonLabel = (reason: string) => {
    switch (reason) {
      case "auto-save":
        return "Auto-save";
      case "before-restore":
        return "Before restore";
      case "save":
        return "Save";
      default:
        return reason;
    }
  };

  return (
    <div className="version-history">
      <div className="version-history__header">
        <h3>Version History</h3>
        <button
          className="version-history__close"
          onClick={onClose}
          title="Close"
        >
          ✕
        </button>
      </div>

      {previewVersion && (
        <div className="version-history__preview">
          <div className="version-history__preview-header">
            <span className="version-history__preview-date">
              {formatDate(previewVersion.timestamp)}
            </span>
            <button
              className="version-history__restore-btn"
              onClick={() => handleRestore(previewVersion.versionId)}
            >
              Restore
            </button>
          </div>
          <pre className="version-history__preview-content">
            {previewVersion.content}
          </pre>
        </div>
      )}

      <div className="version-history__list">
        {versions.length === 0 && (
          <p className="version-history__empty">No versions yet</p>
        )}
        {versions.map((v) => (
          <button
            key={v.versionId}
            className={`version-history__item${
              previewVersion?.versionId === v.versionId
                ? " version-history__item--active"
                : ""
            }`}
            onClick={() => handlePreview(v.versionId)}
            disabled={loadingId === v.versionId}
          >
            <span className="version-history__item-date">
              {formatDate(v.timestamp)}
            </span>
            <span className="version-history__item-reason">
              {reasonLabel(v.reason)}
            </span>
            {v.preview && (
              <span className="version-history__item-preview">
                {v.preview.slice(0, 80)}
                {v.preview.length > 80 ? "..." : ""}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
