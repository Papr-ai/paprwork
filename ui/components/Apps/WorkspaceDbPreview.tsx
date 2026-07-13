/**
 * WorkspaceDbPreview — table browser for job SQLite databases.
 */

import React from "react";
import type { JobDbPreviewResult } from "../../hooks/useAppWorkspace";
import "./WorkspaceDbPreview.css";

interface WorkspaceDbPreviewProps {
  preview: JobDbPreviewResult;
  loading: boolean;
  onSelectTable: (tableName: string) => void;
}

export function WorkspaceDbPreview({
  preview,
  loading,
  onSelectTable,
}: WorkspaceDbPreviewProps) {
  const activeTable =
    preview.tables.find((table) => table.name === preview.selectedTable) ??
    preview.tables[0] ??
    null;

  if (!activeTable) {
    return (
      <div className="workspace-db-preview__empty">
        <p>No user tables found in this database yet.</p>
        <p className="workspace-db-preview__hint">
          Run the linked job to populate data.
        </p>
      </div>
    );
  }

  const columns =
    activeTable.columns.length > 0
      ? activeTable.columns.map((column) => column.name)
      : activeTable.rows[0]
        ? Object.keys(activeTable.rows[0])
        : [];

  return (
    <div className="workspace-db-preview">
      <div className="workspace-db-preview__tabs" role="tablist">
        {preview.tables.map((table) => (
          <button
            key={table.name}
            type="button"
            role="tab"
            aria-selected={table.name === activeTable.name}
            className={
              table.name === activeTable.name
                ? "workspace-db-preview__tab workspace-db-preview__tab--active"
                : "workspace-db-preview__tab"
            }
            onClick={() => onSelectTable(table.name)}
          >
            {table.name}
            <span className="workspace-db-preview__tab-count">
              {table.rowCount.toLocaleString()}
            </span>
          </button>
        ))}
      </div>

      <div className="workspace-db-preview__meta">
        <span>
          Showing {Math.min(activeTable.rows.length, 50)} of{" "}
          {activeTable.rowCount.toLocaleString()} rows
        </span>
        {loading ? <span>Refreshing…</span> : null}
      </div>

      <div className="workspace-db-preview__table-wrap">
        <table className="workspace-db-preview__table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activeTable.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {columns.map((column) => (
                  <td key={column}>{formatCell(row[column])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {activeTable.rows.length === 0 ? (
          <p className="workspace-db-preview__empty-rows">No rows in this table.</p>
        ) : null}
      </div>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
