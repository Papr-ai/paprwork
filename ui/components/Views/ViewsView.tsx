/**
 * ViewsView - Tables organized by app
 *
 * Displays all SQLite tables from app-linked data sources.
 * Click a table card to open the table data view.
 */

import React from "react";
import { useViews } from "../../hooks/useViews";
import { useTabs } from "../../hooks/useTabs";
import "./ViewsView.css";

/** entityId format: appId|sourceId|tableName (sourceId can be empty for single-source) */
function encodeViewId(
  appId: string,
  sourceId: string,
  tableName: string,
): string {
  return `${appId}|${sourceId}|${tableName}`;
}

export function ViewsView() {
  const { apps, loading, error, reload } = useViews();
  const { createTab, switchToTab } = useTabs();

  const handleOpenTable = (
    appId: string,
    appTitle: string,
    sourceId: string,
    tableName: string,
  ) => {
    const entityId = encodeViewId(appId, sourceId, tableName);
    const tabId = createTab("view", entityId, `${appTitle} · ${tableName}`);
    switchToTab(tabId);
  };

  if (loading) {
    return (
      <div className="views-view">
        <div className="views-view__loading">Loading views…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="views-view">
        <div className="views-view__header">
          <h2 className="views-view__title">Views</h2>
        </div>
        <div className="views-view__error">
          {error}
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (apps.length === 0) {
    return (
      <div className="views-view">
        <div className="views-view__header">
          <h2 className="views-view__title">Views</h2>
        </div>
        <div className="views-view__empty">
          <p>No data views yet.</p>
          <p className="views-view__empty-hint">
            Link a job&apos;s SQLite database to an app using{" "}
            <code>link_app_data_source</code>, then tables will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="views-view">
      <div className="views-view__header">
        <h2 className="views-view__title">Views</h2>
        <button
          type="button"
          className="views-view__refresh"
          onClick={reload}
          title="Refresh"
        >
          ↻ Refresh
        </button>
      </div>

      <div className="views-view__content">
        {apps.map((app) => (
          <div key={app.appId} className="views-view__app-section">
            <h3 className="views-view__app-title">{app.appTitle}</h3>
            {app.sources.map((source) =>
              source.tables.length === 0 ? null : (
                <div key={source.sourceId} className="views-view__tables">
                  {source.tables.map(({ table }) => (
                    <button
                      key={table}
                      type="button"
                      className="views-view__table-card"
                      onClick={() =>
                        handleOpenTable(
                          app.appId,
                          app.appTitle,
                          source.sourceId,
                          table,
                        )
                      }
                    >
                      <span className="views-view__table-name">{table}</span>
                    </button>
                  ))}
                </div>
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
