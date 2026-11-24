/**
 * VersionHistory - Slide-out panel showing document version history.
 *
 * Named versions ("v1", "v2 after review") are pinned at the top and kept
 * forever; auto-saves are listed below as a rolling safety net.
 */

import React, { useState, useCallback, useMemo } from "react";
import type {
  DocumentVersion,
  DocumentVersionFull,
} from "../../hooks/useDocuments";
import { markdownPreviewText } from "../../../src/core/utils/markdownPreview";
import "./VersionHistory.css";

interface VersionHistoryProps {
  versions: DocumentVersion[];
  onGetVersion: (versionId: string) => Promise<DocumentVersionFull | null>;
  onRestore: (versionId: string) => void;
  onSaveNamed: (label: string) => Promise<void>;
  onClose: () => void;
}

const SYSTEM_LABELS: Record<string, string> = {
  "auto-save": "Auto-save",
  "before-restore": "Before restore",
  save: "Save",
  imported: "Imported",
};

export function isNamed(v: DocumentVersion): boolean {
  return v.named ?? !(v.reason in SYSTEM_LABELS);
}

export function versionLabel(reason: string): string {
  return SYSTEM_LABELS[reason] ?? reason.replace(/-/g, " ");
}

export function formatVersionDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const diffMins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 60 * 24) return `${Math.floor(diffMins / 60)}h ago`;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function VersionHistory({
  versions,
  onGetVersion,
  onRestore,
  onSaveNamed,
  onClose,
}: VersionHistoryProps) {
  const [previewVersion, setPreviewVersion] =
    useState<DocumentVersionFull | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [savingLabel, setSavingLabel] = useState(false);

  const { named, auto } = useMemo(
    () => ({
      named: versions.filter(isNamed),
      auto: versions.filter((v) => !isNamed(v)),
    }),
    [versions],
  );

  const handlePreview = useCallback(
    async (versionId: string) => {
      setLoadingId(versionId);
      setPreviewVersion(await onGetVersion(versionId));
      setLoadingId(null);
    },
    [onGetVersion],
  );

  const handleSave = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!label.trim()) return;
      setSavingLabel(true);
      await onSaveNamed(label.trim());
      setSavingLabel(false);
      setLabel("");
    },
    [label, onSaveNamed],
  );

  const renderItem = (v: DocumentVersion) => (
    <button
      key={v.versionId}
      className={`version-history__item${
        previewVersion?.versionId === v.versionId
          ? " version-history__item--active"
          : ""
      }${isNamed(v) ? " version-history__item--named" : ""}`}
      onClick={() => handlePreview(v.versionId)}
      disabled={loadingId === v.versionId}
    >
      <span className="version-history__item-row">
        <span className="version-history__item-reason">
          {versionLabel(v.reason)}
        </span>
        <span className="version-history__item-date">
          {formatVersionDate(v.timestamp)}
        </span>
      </span>
      {v.preview && (
        <span className="version-history__item-preview">
          {markdownPreviewText(v.preview, 80)}
        </span>
      )}
    </button>
  );

  return (
    <div className="version-history">
      <div className="version-history__header">
        <h3>Version History</h3>
        <button className="version-history__close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <form className="version-history__save" onSubmit={handleSave}>
        <input
          className="version-history__save-input"
          placeholder="Name this version, e.g. v2"
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button
          className="version-history__save-btn"
          type="submit"
          disabled={!label.trim() || savingLabel}
        >
          {savingLabel ? "Saving…" : "Save"}
        </button>
      </form>

      {previewVersion && (
        <div className="version-history__preview">
          <div className="version-history__preview-header">
            <span className="version-history__preview-date">
              {versionLabel(previewVersion.reason)} ·{" "}
              {formatVersionDate(previewVersion.timestamp)}
            </span>
            <button
              className="version-history__restore-btn"
              onClick={() => {
                onRestore(previewVersion.versionId);
                setPreviewVersion(null);
              }}
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
        {named.length > 0 && (
          <p className="version-history__section">Named</p>
        )}
        {named.map(renderItem)}
        {auto.length > 0 && named.length > 0 && (
          <p className="version-history__section">Auto-saves</p>
        )}
        {auto.map(renderItem)}
      </div>
    </div>
  );
}
