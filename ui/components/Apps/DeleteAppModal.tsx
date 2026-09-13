/**
 * DeleteAppModal - Comprehensive delete confirmation modal
 * Shows all data that will be deleted and requires typing app name to confirm
 */

import React, { useState, useRef, useEffect, useMemo } from "react";
import "./DeleteAppModal.css";

interface LinkedJobInfo {
  id: string;
  name: string;
  type: string;
  hasTursoDb?: boolean;
}

interface LinkedRegistryDbInfo {
  dbId: string;
  alias: string;
  label: string;
  tursoShortName: string;
  sharedWithApps: Array<{ appId: string; title: string }>;
  soleLinker: boolean;
}

interface DeleteAppPreview {
  appId: string;
  appTitle: string;
  isPublished: boolean;
  shareUrl?: string | null;
  linkedJobs: LinkedJobInfo[];
  tursoDbCount: number;
  linkedRegistryDatabases: LinkedRegistryDbInfo[];
}

interface DeleteAppModalProps {
  isOpen: boolean;
  preview: DeleteAppPreview | null;
  onClose: () => void;
  onConfirm: (options: {
    deleteLinkedJobs: boolean;
    deleteTursoDatabases: boolean;
    deleteRegistryDbIds: string[];
    deleteRegistryTurso: boolean;
    unpublishFromCloud: boolean;
  }) => void | Promise<void>;
  deleteError?: string | null;
}

export function DeleteAppModal({
  isOpen,
  preview,
  onClose,
  onConfirm,
  deleteError = null,
}: DeleteAppModalProps) {
  const [confirmText, setConfirmText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteJobs, setDeleteJobs] = useState(true);
  const [deleteTurso, setDeleteTurso] = useState(true);
  const [deleteRegistryDbs, setDeleteRegistryDbs] = useState(false);
  const [deleteRegistryTurso, setDeleteRegistryTurso] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const linkedRegistryDatabases = preview?.linkedRegistryDatabases ?? [];
  const sharedRegistryDbs = useMemo(
    () => linkedRegistryDatabases.filter((db) => !db.soleLinker),
    [linkedRegistryDatabases],
  );
  const soleLinkerRegistryDbs = useMemo(
    () => linkedRegistryDatabases.filter((db) => db.soleLinker),
    [linkedRegistryDatabases],
  );

  useEffect(() => {
    if (isOpen) {
      setConfirmText("");
      setDeleteJobs(true);
      setDeleteTurso(true);
      setDeleteRegistryDbs(false);
      setDeleteRegistryTurso(true);
      setIsDeleting(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (isDeleting) return;
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose, isDeleting]);

  if (!isOpen || !preview) return null;

  const isConfirmValid = confirmText === preview.appTitle;
  const hasLinkedJobs = preview.linkedJobs.length > 0;
  const hasTursoDbs = preview.tursoDbCount > 0;

  const handleConfirm = async () => {
    if (!isConfirmValid || isDeleting) return;
    setIsDeleting(true);
    try {
      await onConfirm({
        deleteLinkedJobs: deleteJobs,
        deleteTursoDatabases: deleteTurso && deleteJobs,
        deleteRegistryDbIds: deleteRegistryDbs
          ? soleLinkerRegistryDbs.map((db) => db.dbId)
          : [],
        deleteRegistryTurso: deleteRegistryTurso && deleteRegistryDbs,
        unpublishFromCloud: preview.isPublished,
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleBackdropClick = () => {
    if (isDeleting) return;
    onClose();
  };

  return (
    <div className="delete-app-modal__backdrop" onClick={handleBackdropClick}>
      <div
        className={`delete-app-modal${isDeleting ? " delete-app-modal--busy" : ""}`}
        onClick={(e) => e.stopPropagation()}
        aria-busy={isDeleting}
      >
        <div className="delete-app-modal__header">
          <div className="delete-app-modal__icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <h3 className="delete-app-modal__title">Delete App</h3>
        </div>

        <p className="delete-app-modal__warning">
          This action <strong>cannot be undone</strong>. This will permanently delete
          the app <strong>"{preview.appTitle}"</strong> and its source files.
        </p>

        <div className="delete-app-modal__summary">
          <div className="delete-app-modal__summary-title">What will be deleted:</div>

          <div className="delete-app-modal__item delete-app-modal__item--always">
            <span className="delete-app-modal__item-icon">📁</span>
            <span>App source files (HTML, JS, config)</span>
          </div>

          {preview.isPublished && (
            <div className="delete-app-modal__item delete-app-modal__item--always">
              <span className="delete-app-modal__item-icon">🌐</span>
              <span>
                Published web app
                {preview.shareUrl && (
                  <span className="delete-app-modal__url">{preview.shareUrl}</span>
                )}
              </span>
            </div>
          )}

          {sharedRegistryDbs.map((db) => (
            <div
              key={db.dbId}
              className="delete-app-modal__item delete-app-modal__item--shared-db"
            >
              <span className="delete-app-modal__item-icon">🔗</span>
              <div className="delete-app-modal__shared-db-content">
                <span>
                  Database <strong>{db.label}</strong> ({db.alias}) stays — also used by{" "}
                  {db.sharedWithApps.map((app) => app.title).join(", ")}
                </span>
                <div className="delete-app-modal__option-hint">
                  Deleting this app removes its link only. Other apps keep using the same
                  local database and Turso replica.
                </div>
              </div>
            </div>
          ))}

          {soleLinkerRegistryDbs.length > 0 && (
            <label className="delete-app-modal__option">
              <input
                type="checkbox"
                checked={deleteRegistryDbs}
                onChange={(e) => setDeleteRegistryDbs(e.target.checked)}
              />
              <div className="delete-app-modal__option-content">
                <div className="delete-app-modal__option-label">
                  <span className="delete-app-modal__item-icon">🗄️</span>
                  <span>
                    {soleLinkerRegistryDbs.length} linked database
                    {soleLinkerRegistryDbs.length !== 1 ? "s" : ""} only used by this app
                  </span>
                </div>
                <div className="delete-app-modal__job-list">
                  {soleLinkerRegistryDbs.map((db) => (
                    <div key={db.dbId} className="delete-app-modal__job">
                      <span className="delete-app-modal__job-name">{db.label}</span>
                      <span className="delete-app-modal__job-type">{db.alias}</span>
                    </div>
                  ))}
                </div>
                <div className="delete-app-modal__option-hint">
                  Unchecked by default — local SQLite files and registry entry remain on disk.
                </div>
              </div>
            </label>
          )}

          {soleLinkerRegistryDbs.length > 0 && deleteRegistryDbs && (
            <label className="delete-app-modal__option delete-app-modal__option--nested">
              <input
                type="checkbox"
                checked={deleteRegistryTurso}
                onChange={(e) => setDeleteRegistryTurso(e.target.checked)}
              />
              <div className="delete-app-modal__option-content">
                <div className="delete-app-modal__option-label">
                  <span className="delete-app-modal__item-icon">☁️</span>
                  <span>
                    Turso cloud replica
                    {soleLinkerRegistryDbs.length === 1
                      ? ` (${soleLinkerRegistryDbs[0]?.tursoShortName})`
                      : "s"}
                  </span>
                </div>
                <div className="delete-app-modal__option-hint">
                  Remote database on Turso. Uncheck to keep the cloud replica.
                </div>
              </div>
            </label>
          )}

          {hasLinkedJobs && (
            <label className="delete-app-modal__option">
              <input
                type="checkbox"
                checked={deleteJobs}
                onChange={(e) => setDeleteJobs(e.target.checked)}
              />
              <div className="delete-app-modal__option-content">
                <div className="delete-app-modal__option-label">
                  <span className="delete-app-modal__item-icon">⚙️</span>
                  <span>{preview.linkedJobs.length} linked job{preview.linkedJobs.length !== 1 ? "s" : ""}</span>
                </div>
                <div className="delete-app-modal__job-list">
                  {preview.linkedJobs.map((job) => (
                    <div key={job.id} className="delete-app-modal__job">
                      <span className="delete-app-modal__job-name">{job.name}</span>
                      <span className="delete-app-modal__job-type">{job.type}</span>
                      {job.hasTursoDb && (
                        <span className="delete-app-modal__job-turso">☁️ Turso</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </label>
          )}

          {hasTursoDbs && deleteJobs && (
            <label className="delete-app-modal__option delete-app-modal__option--nested">
              <input
                type="checkbox"
                checked={deleteTurso}
                onChange={(e) => setDeleteTurso(e.target.checked)}
              />
              <div className="delete-app-modal__option-content">
                <div className="delete-app-modal__option-label">
                  <span className="delete-app-modal__item-icon">☁️</span>
                  <span>{preview.tursoDbCount} Turso cloud database{preview.tursoDbCount !== 1 ? "s" : ""}</span>
                </div>
                <div className="delete-app-modal__option-hint">
                  Job scratch databases synced to Turso. Uncheck to keep them.
                </div>
              </div>
            </label>
          )}
        </div>

        {isDeleting && (
          <div className="delete-app-modal__progress" role="status">
            <span className="delete-app-modal__progress-spinner" aria-hidden />
            <span>
              Deleting app… This can take up to a minute if cloud unpublish or
              linked jobs are included.
            </span>
          </div>
        )}

        {deleteError && !isDeleting && (
          <p className="delete-app-modal__error" role="alert">
            {deleteError}
          </p>
        )}

        <div className="delete-app-modal__confirm">
          <label className="delete-app-modal__confirm-label">
            Type <strong>{preview.appTitle}</strong> to confirm:
          </label>
          <input
            ref={inputRef}
            type="text"
            className="delete-app-modal__input"
            placeholder={preview.appTitle}
            value={confirmText}
            disabled={isDeleting}
            onChange={(e) => setConfirmText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && isConfirmValid && !isDeleting) {
                void handleConfirm();
              }
            }}
          />
        </div>

        <div className="delete-app-modal__actions">
          <button
            className="delete-app-modal__cancel"
            disabled={isDeleting}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="delete-app-modal__delete"
            disabled={!isConfirmValid || isDeleting}
            onClick={() => void handleConfirm()}
          >
            {isDeleting ? (
              <>
                <span className="delete-app-modal__progress-spinner delete-app-modal__progress-spinner--inline" aria-hidden />
                Deleting…
              </>
            ) : (
              "Delete App"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
