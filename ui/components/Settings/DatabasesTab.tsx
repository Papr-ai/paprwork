/**
 * DatabasesTab — list registered databases from databases.json
 */

import React, { useCallback, useEffect, useState } from "react";
import "./DatabasesTab.css";

const GATEWAY = "http://localhost:18789";

interface RegistryDatabase {
  dbId: string;
  label: string;
  localPath: string;
  tursoShortName: string;
  ownerJobId?: string;
  isolation: "shared" | "per-user";
  linkedAppCount: number;
  createdAt: string;
  updatedAt: string;
}

export function DatabasesTab() {
  const [databases, setDatabases] = useState<RegistryDatabase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY}/api/databases`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { databases?: RegistryDatabase[] };
      setDatabases(data.databases ?? []);
    } catch (err) {
      setError((err as Error).message);
      setDatabases([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="databases-tab">
      <div className="databases-tab__header">
        <div>
          <h2 className="databases-tab__title">Databases</h2>
          <p className="databases-tab__subtitle">
            First-class SQLite resources linked to mini-apps via data-sources.json.
            Create with <code>create_database</code>, attach with{" "}
            <code>attach_database</code>.
          </p>
        </div>
        <button
          type="button"
          className="databases-tab__refresh"
          onClick={() => void load()}
          disabled={loading}
        >
          Refresh
        </button>
      </div>

      {loading ? <p className="databases-tab__status">Loading…</p> : null}
      {error ? <p className="databases-tab__error">{error}</p> : null}

      {!loading && !error && databases.length === 0 ? (
        <p className="databases-tab__empty">
          No registered databases yet. Link a job to an app or run{" "}
          <code>npm run migrate:databases-registry</code> after adding data sources.
        </p>
      ) : null}

      {!loading && databases.length > 0 ? (
        <div className="databases-tab__list">
          {databases.map((db) => (
            <article key={db.dbId} className="databases-tab__card">
              <div className="databases-tab__card-head">
                <h3>{db.label || db.dbId}</h3>
                <span className="databases-tab__badge">{db.tursoShortName}</span>
              </div>
              <dl className="databases-tab__meta">
                <div>
                  <dt>ID</dt>
                  <dd>
                    <code>{db.dbId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Path</dt>
                  <dd>
                    <code>{db.localPath}</code>
                  </dd>
                </div>
                <div>
                  <dt>Isolation</dt>
                  <dd>{db.isolation}</dd>
                </div>
                <div>
                  <dt>Linked apps</dt>
                  <dd>{db.linkedAppCount}</dd>
                </div>
                {db.ownerJobId ? (
                  <div>
                    <dt>Owner job</dt>
                    <dd>
                      <code>{db.ownerJobId}</code>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
