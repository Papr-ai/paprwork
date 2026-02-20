/**
 * TableView - Display SQLite table data
 *
 * Shown when user clicks a table card in ViewsView.
 * entityId format: appId|sourceId|tableName
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useAppDataSources } from "../../hooks/useAppDataSources";
import "./TableView.css";

const LOAD_TIMEOUT_MS = 5000;

function parseViewId(
  entityId: string,
): { appId: string; sourceId: string; tableName: string } | null {
  const parts = entityId.split("|");
  if (parts.length < 3) return null;
  return {
    appId: parts[0],
    sourceId: parts[1],
    tableName: parts[2],
  };
}

const PAGE_SIZE = 50;

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

interface TableViewProps {
  entityId: string;
}

export function TableView({ entityId }: TableViewProps) {
  const parsed = parseViewId(entityId);
  const [page, setPage] = useState(1);

  const appId = parsed?.appId ?? null;
  const sourceId = parsed?.sourceId || undefined;
  const tableName = parsed?.tableName ?? "";

  const { queryTable, getTotalCount } = useAppDataSources(appId, {
    skipSchema: true,
  });
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRetry, setShowRetry] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadIdRef = useRef(0);

  const loadData = useCallback(
    async (pageNum: number) => {
      if (!appId || !tableName) {
        setLoading(false);
        setError("Invalid app or table");
        return;
      }
      const thisLoadId = ++loadIdRef.current;
      setLoading(true);
      setError(null);
      setShowRetry(false);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      timeoutRef.current = setTimeout(() => {
        setShowRetry(true);
      }, LOAD_TIMEOUT_MS);
      try {
        const queryResult = await queryTable(tableName, pageNum, sourceId);
        if (thisLoadId !== loadIdRef.current) return;
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        setRows(queryResult.rows);
        setColumns(queryResult.columns);
        setLoading(false);

        getTotalCount(tableName, sourceId)
          .then((count) => {
            if (thisLoadId === loadIdRef.current) setTotalCount(count);
          })
          .catch(() => {
            if (thisLoadId === loadIdRef.current) setTotalCount(0);
          });
      } catch (err) {
        if (thisLoadId !== loadIdRef.current) return;
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        const errMsg =
          err instanceof Error ? err.message : "Failed to load table";
        setError(errMsg);
        setRows([]);
        setColumns([]);
        setTotalCount(0);
        setShowRetry(true);
      } finally {
        if (thisLoadId === loadIdRef.current) setLoading(false);
      }
    },
    [appId, tableName, sourceId, queryTable, getTotalCount],
  );

  useEffect(() => {
    if (parsed) loadData(page);
    return () => {
      loadIdRef.current++;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [parsed?.appId, parsed?.tableName, page, loadData]);

  if (!parsed) {
    return (
      <div className="table-view">
        <div className="table-view__error">Invalid view</div>
      </div>
    );
  }

  const totalPages =
    totalCount !== null ? Math.max(1, Math.ceil(totalCount / PAGE_SIZE)) : null;

  const handlePageChange = (delta: number) => {
    setPage((p) => {
      const next = p + delta;
      if (next < 1) return 1;
      if (totalPages !== null && next > totalPages) return totalPages;
      return next;
    });
  };

  return (
    <div className="table-view">
      <div className="table-view__header">
        <h2 className="table-view__title">{tableName}</h2>
        {totalCount !== null && (
          <span className="table-view__count">
            {totalCount} row{totalCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {loading ? (
        <div className="table-view__loading">
          <span>Loading…</span>
          {showRetry && (
            <>
              <span className="table-view__loading-hint">
                Taking longer than expected?
              </span>
              <button
                type="button"
                className="table-view__retry"
                onClick={() => loadData(page)}
              >
                Retry
              </button>
            </>
          )}
        </div>
      ) : error ? (
        <div className="table-view__error">
          {error}
          <button
            type="button"
            className="table-view__retry"
            onClick={() => loadData(page)}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="table-view__table-wrap">
            <table className="table-view__table">
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length || 1}
                      className="table-view__empty"
                    >
                      No rows
                    </td>
                  </tr>
                ) : (
                  rows.map((row, i) => (
                    <tr key={i}>
                      {columns.map((col) => (
                        <td key={col}>{formatCell(row[col])}</td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Show pagination when >1 page (known) or when we have a full page (might be more) */}
          {(totalCount === null
            ? rows.length >= PAGE_SIZE
            : totalCount > PAGE_SIZE) && (
            <div className="table-view__pagination">
              <button
                type="button"
                onClick={() => handlePageChange(-1)}
                disabled={page <= 1}
              >
                ← Prev
              </button>
              <span>
                Page {page}
                {totalCount !== null ? ` of ${totalPages}` : ""}
              </span>
              <button
                type="button"
                onClick={() => handlePageChange(1)}
                disabled={
                  totalCount !== null
                    ? page >= totalPages
                    : rows.length < PAGE_SIZE
                }
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
