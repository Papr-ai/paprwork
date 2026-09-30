/**
 * MiniAppDataSourcesPanel — view linked sources and attach registry databases.
 */

import React, { useCallback, useEffect, useState } from "react";
import "./MiniAppDataSourcesPanel.css";

const GATEWAY = "http://localhost:18789";

interface LinkedSource {
  alias: string;
  dbId?: string;
  jobId?: string;
  dbPath: string;
}

interface RegistryDatabase {
  dbId: string;
  label: string;
  localPath: string;
  tursoShortName: string;
}

interface MiniAppDataSourcesPanelProps {
  appId: string;
}

export function MiniAppDataSourcesPanel({ appId }: MiniAppDataSourcesPanelProps) {
  const [linked, setLinked] = useState<LinkedSource[]>([]);
  const [registry, setRegistry] = useState<RegistryDatabase[]>([]);
  const [selectedDbId, setSelectedDbId] = useState("");
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [healthRes, dbRes] = await Promise.all([
        fetch(`${GATEWAY}/api/apps/${appId}/data-health`),
        fetch(`${GATEWAY}/api/databases`),
      ]);
      if (!healthRes.ok) {
        throw new Error(`data-health HTTP ${healthRes.status}`);
      }
      const health = (await healthRes.json()) as {
        linkedSources?: LinkedSource[];
      };
      setLinked(health.linkedSources ?? []);

      if (dbRes.ok) {
        const dbData = (await dbRes.json()) as { databases?: RegistryDatabase[] };
        setRegistry(dbData.databases ?? []);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  const linkDatabase = async () => {
    if (!selectedDbId) return;
    setLinking(true);
    setError(null);
    try {
      const record = registry.find((db) => db.dbId === selectedDbId);
      const res = await fetch(`${GATEWAY}/api/apps/${appId}/link-database`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dbId: selectedDbId,
          alias: record?.label ?? selectedDbId,
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setSelectedDbId("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLinking(false);
    }
  };

  const availableToLink = registry.filter(
    (db) => !linked.some((source) => source.dbId === db.dbId),
  );

  const registryLabelFor = (dbId?: string): string | undefined =>
    dbId ? registry.find((db) => db.dbId === dbId)?.label : undefined;

  const displayTitle = (source: LinkedSource): string => {
    const label = registryLabelFor(source.dbId);
    if (label?.trim()) {
      return label.trim();
    }
    if (source.alias === "primary") {
      return "Linked database";
    }
    return source.alias;
  };

  return (
    <section className="mini-app-data-sources">
      <div className="mini-app-data-sources__head">
        <h3>Data sources</h3>
        <button type="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>

      {loading ? <p className="mini-app-data-sources__hint">Loading…</p> : null}
      {error ? <p className="mini-app-data-sources__error">{error}</p> : null}

      {!loading && linked.length === 0 ? (
        <p className="mini-app-data-sources__hint">
          No database linked. Mini-apps using <code>/api/db/*</code> need a source
          before reads and writes work.
        </p>
      ) : null}

      {linked.length > 1 ? (
        <p className="mini-app-data-sources__hint">
          Pass <code>sourceId</code> (alias) on every <code>/api/db/query</code> and{" "}
          <code>/api/db/write</code> call.
        </p>
      ) : null}

      {linked.length > 0 ? (
        <ul className="mini-app-data-sources__list">
          {linked.map((source) => (
            <li key={`${source.alias}-${source.dbPath}`}>
              <strong>{displayTitle(source)}</strong>
              <code className="mini-app-data-sources__source-id">
                sourceId: {source.alias}
              </code>
              <span className="mini-app-data-sources__path">{source.dbPath}</span>
              {source.dbId ? (
                <code className="mini-app-data-sources__id">{source.dbId}</code>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {availableToLink.length > 0 ? (
        <div className="mini-app-data-sources__link">
          <select
            value={selectedDbId}
            onChange={(e) => setSelectedDbId(e.target.value)}
            aria-label="Registry database"
          >
            <option value="">Link registry database…</option>
            {availableToLink.map((db) => (
              <option key={db.dbId} value={db.dbId}>
                {db.label} ({db.tursoShortName})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void linkDatabase()}
            disabled={!selectedDbId || linking}
          >
            {linking ? "Linking…" : "Link"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
