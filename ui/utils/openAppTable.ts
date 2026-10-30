/**
 * Open one of an app's tables in its own database view (app tab → DB panel).
 * Used by the Share sheet's table pills. MiniAppView switches to the DB panel,
 * MiniAppFilesView opens the database and selects the table, and the
 * publish bar closes the Share sheet.
 */

export const OPEN_APP_TABLE_EVENT = "papr-app-open-table";

export interface OpenAppTableDetail {
  appId: string;
  /** Data source alias (ScopedTable.db). */
  db: string;
  table: string;
}

export function openAppTable(detail: OpenAppTableDetail): void {
  window.dispatchEvent(new CustomEvent<OpenAppTableDetail>(OPEN_APP_TABLE_EVENT, { detail }));
}

export function onOpenAppTable(appId: string, fn: (d: OpenAppTableDetail) => void): () => void {
  const handler = (e: Event) => {
    const d = (e as CustomEvent<OpenAppTableDetail>).detail;
    if (d?.appId === appId) fn(d);
  };
  window.addEventListener(OPEN_APP_TABLE_EVENT, handler);
  return () => window.removeEventListener(OPEN_APP_TABLE_EVENT, handler);
}
