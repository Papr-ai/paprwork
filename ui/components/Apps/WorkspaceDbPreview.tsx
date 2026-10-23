/**
 * WorkspaceDbPreview — table browser for job SQLite databases.
 */

import React, { useEffect, useRef } from "react";
import type { JobDbPreviewResult } from "../../hooks/useAppWorkspace";
import "./WorkspaceDbPreview.css";

interface WorkspaceDbPreviewProps {
  preview: JobDbPreviewResult;
  loading: boolean;
  onSelectTable: (tableName: string) => void;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}

const PAGE_SIZES = [20, 50, 100];

export function WorkspaceDbPreview({
  preview,
  loading,
  onSelectTable,
  onPageChange,
  onPageSizeChange,
}: WorkspaceDbPreviewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const pageSize = preview.limit ?? 50;
  const offset = preview.offset ?? 0;

  // New page or table: start at the top-left of the grid, not mid-scroll.
  useEffect(() => {
    wrapRef.current?.scrollTo({ top: 0, left: 0 });
  }, [offset, pageSize, preview.selectedTable]);

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

  const page = Math.floor(offset / pageSize);
  const pageCount = Math.max(1, Math.ceil(activeTable.rowCount / pageSize));

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
          {activeTable.rows.length === 0
            ? "0 rows"
            : `Rows ${(offset + 1).toLocaleString()}–${(
                offset + activeTable.rows.length
              ).toLocaleString()} of ${activeTable.rowCount.toLocaleString()}`}
        </span>
        {loading ? <span>Loading…</span> : null}
      </div>

      <div className="workspace-db-preview__table-wrap" ref={wrapRef}>
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
          <p className="workspace-db-preview__empty-rows">
            {activeTable.rowCount === 0
              ? "No rows in this table."
              : "No rows on this page."}
          </p>
        ) : null}
      </div>

      {onPageChange ? (
        <div className="workspace-db-preview__pager">
          <label className="workspace-db-preview__pager-size">
            Rows per page
            <select
              value={pageSize}
              disabled={loading}
              onChange={(e) => onPageSizeChange?.(Number(e.target.value))}
            >
              {[...new Set([...PAGE_SIZES, pageSize])]
                .sort((a, b) => a - b)
                .map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
            </select>
          </label>
          <span className="workspace-db-preview__pager-pos">
            Page {page + 1} of {pageCount}
          </span>
          <div className="workspace-db-preview__pager-nav">
            <button type="button" aria-label="First page" disabled={loading || page === 0} onClick={() => onPageChange(0)}>«</button>
            <button type="button" aria-label="Previous page" disabled={loading || page === 0} onClick={() => onPageChange(page - 1)}>‹ Prev</button>
            <button type="button" aria-label="Next page" disabled={loading || page >= pageCount - 1} onClick={() => onPageChange(page + 1)}>Next ›</button>
            <button type="button" aria-label="Last page" disabled={loading || page >= pageCount - 1} onClick={() => onPageChange(pageCount - 1)}>»</button>
          </div>
        </div>
      ) : null}
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
