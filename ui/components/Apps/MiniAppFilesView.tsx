/**
 * MiniAppFilesView — folder tree, syntax-highlighted editor, and DB preview.
 */

import React, { useEffect, useMemo } from "react";
import {
  detectWorkspaceLanguage,
  useAppWorkspace,
} from "../../hooks/useAppWorkspace";
import { WorkspaceCodeEditor } from "./WorkspaceCodeEditor";
import { WorkspaceDbPreview } from "./WorkspaceDbPreview";
import { WorkspaceFileTree } from "./WorkspaceFileTree";
import { MiniAppDataSourcesPanel } from "./MiniAppDataSourcesPanel";
import "./MiniAppFilesView.css";
import "./WorkspaceCodeEditor.css";
import "./WorkspaceDbPreview.css";
import "./WorkspaceFileTree.css";

interface MiniAppFilesViewProps {
  appId: string;
}

function AppIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="4"
        y="5"
        width="16"
        height="14"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M8 9h8M8 12h5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function JobIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M16.9 16.9l2.1 2.1M4.9 19.1l2.1-2.1M16.9 7.1l2.1-2.1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MiniAppFilesView({ appId }: MiniAppFilesViewProps) {
  const workspace = useAppWorkspace(appId);

  const language = workspace.selected
    ? detectWorkspaceLanguage(workspace.selected.path)
    : "text";

  const appGroup = useMemo(
    () => workspace.workspace?.appFiles ?? [],
    [workspace.workspace],
  );

  const jobGroups = useMemo(
    () => workspace.workspace?.jobs ?? [],
    [workspace.workspace],
  );

  const canSave =
    workspace.selected != null &&
    workspace.viewMode === "code" &&
    !workspace.selected.readOnly &&
    workspace.selected.kind === "file";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
        return;
      }
      if (!canSave || !workspace.isDirty || workspace.saving || workspace.loadingFile) {
        return;
      }
      event.preventDefault();
      void workspace.saveFile();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    canSave,
    workspace.isDirty,
    workspace.saving,
    workspace.loadingFile,
    workspace.saveFile,
  ]);

  return (
    <div className="mini-app-files">
      <aside className="mini-app-files__sidebar">
        <div className="mini-app-files__sidebar-header">
          <span className="mini-app-files__sidebar-title">Workspace</span>
          <button
            type="button"
            className="mini-app-files__refresh"
            disabled={workspace.loadingTree}
            onClick={() => void workspace.refreshTree()}
          >
            {workspace.loadingTree ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <div className="mini-app-files__tree">
          <MiniAppDataSourcesPanel appId={appId} />

          {appGroup.length === 0 && jobGroups.length === 0 && !workspace.loadingTree ? (
            <p className="mini-app-files__empty">No files found.</p>
          ) : null}

          {appGroup.length > 0 ? (
            <section className="mini-app-files__group mini-app-files__group--app">
              <header className="mini-app-files__group-header">
                <span className="mini-app-files__group-icon">
                  <AppIcon />
                </span>
                <div className="mini-app-files__group-copy">
                  <span className="mini-app-files__group-label">App</span>
                  <span className="mini-app-files__group-sub">Source files</span>
                </div>
              </header>
              <WorkspaceFileTree
                entries={appGroup}
                scope="app"
                appId={appId}
                selectedKey={workspace.selectedKey}
                onSelect={(target) => void workspace.openTarget(target)}
              />
            </section>
          ) : null}

          {jobGroups.map((job) => (
            <section
              key={job.jobId}
              className="mini-app-files__group mini-app-files__group--job"
            >
              <header className="mini-app-files__group-header">
                <span className="mini-app-files__group-icon mini-app-files__group-icon--job">
                  <JobIcon />
                </span>
                <div className="mini-app-files__group-copy">
                  <span className="mini-app-files__group-label">{job.name}</span>
                  <span className="mini-app-files__group-sub">
                    <span className="mini-app-files__job-badge">Job</span>
                    {job.alias}
                  </span>
                </div>
              </header>
              <WorkspaceFileTree
                entries={job.files}
                scope="job"
                appId={appId}
                jobId={job.jobId}
                selectedKey={workspace.selectedKey}
                onSelect={(target) => void workspace.openTarget(target)}
              />
            </section>
          ))}
        </div>
      </aside>

      <section className="mini-app-files__editor">
        {!workspace.selected ? (
          <div className="mini-app-files__placeholder">
            <p>Select a file to view or edit its source.</p>
            <p className="mini-app-files__placeholder-sub">
              Click a database file to preview tables and rows.
            </p>
          </div>
        ) : (
          <>
            <header className="mini-app-files__editor-header">
              <div className="mini-app-files__editor-meta">
                <span className="mini-app-files__editor-path">
                  {workspace.selected.path}
                </span>
                {workspace.viewMode === "code" ? (
                  <span className="mini-app-files__editor-lang">{language}</span>
                ) : (
                  <span className="mini-app-files__editor-lang">database</span>
                )}
                {workspace.selected.scope === "job" ? (
                  <span className="mini-app-files__job-badge">Job</span>
                ) : null}
              </div>
              <div className="mini-app-files__editor-actions">
                {workspace.isDirty ? (
                  <span className="mini-app-files__dirty">Unsaved changes</span>
                ) : null}
                {canSave ? (
                  <button
                    type="button"
                    className="mini-app-files__save"
                    disabled={
                      workspace.saving ||
                      workspace.loadingFile ||
                      !workspace.isDirty
                    }
                    onClick={() => void workspace.saveFile()}
                  >
                    {workspace.saving ? "Saving…" : "Save"}
                  </button>
                ) : null}
              </div>
            </header>

            {workspace.externalChange ? (
              <div className="mini-app-files__banner">
                <span>
                  The agent updated <strong>{workspace.externalChange}</strong>.
                </span>
                <button
                  type="button"
                  className="mini-app-files__banner-btn"
                  onClick={() => void workspace.reloadFromDisk()}
                >
                  Reload from disk
                </button>
              </div>
            ) : null}

            {workspace.error ? (
              <div className="mini-app-files__error">{workspace.error}</div>
            ) : null}

            {workspace.selected.kind === "sqlite-internal" ? (
              <div className="mini-app-files__readonly-note">
                SQLite internal file (WAL/shared memory). Not editable — open{" "}
                <strong>data.db</strong> to preview tables.
              </div>
            ) : null}

            {workspace.viewMode === "database" && workspace.dbPreview ? (
              <WorkspaceDbPreview
                preview={workspace.dbPreview}
                loading={workspace.loadingDb}
                onSelectTable={(tableName) =>
                  void workspace.selectDbTable(tableName)
                }
              />
            ) : null}

            {workspace.viewMode === "code" &&
            workspace.selected.kind !== "sqlite-internal" ? (
              workspace.selected.readOnly && workspace.selected.kind === "log" ? (
                <WorkspaceCodeEditor
                  value={workspace.content}
                  language={language}
                  readOnly
                  onChange={workspace.setContent}
                />
              ) : workspace.selected.readOnly ? (
                <div className="mini-app-files__readonly-note">
                  Generated or binary files cannot be edited here.
                </div>
              ) : (
                <WorkspaceCodeEditor
                  value={workspace.content}
                  language={language}
                  readOnly={workspace.loadingFile}
                  onChange={workspace.setContent}
                />
              )
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
