/**
 * Memory schemas for the active team (moved here from Profile: they're data structure, not you).
 */
import { useCallback, useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import "./PaprLoginSection.css";

interface SchemaInfo {
  id: string;
  name: string;
  description?: string;
  status: string;
  version?: string;
  nodeTypeCount: number;
  relationshipTypeCount: number;
  nodeTypeNames: string[];
  relationshipTypeNames: string[];
}

export function MemorySchemasPanel() {
  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [schemasError, setSchemasError] = useState<string | null>(null);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [expandedSchema, setExpandedSchema] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);

  const loadSchemas = useCallback(async () => {
    setSchemasLoading(true);
    setSchemasError(null);
    try {
      const fetchSchemas = () =>
        gateway.send("memory:list-schemas", {}, { timeoutMs: 45_000 });

      let response: Awaited<ReturnType<typeof fetchSchemas>>;
      try {
        response = await fetchSchemas();
      } catch (firstError) {
        const message =
          firstError instanceof Error ? firstError.message : String(firstError);
        if (!message.includes("timeout")) {
          throw firstError;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
        response = await fetchSchemas();
      }

      const data = response.data as
        | { schemas?: SchemaInfo[]; error?: string }
        | undefined;
      setSchemas(data?.schemas ?? []);
      setSchemasError(data?.error?.trim() ? data.error.trim() : null);
    } catch (err) {
      console.error("Failed to load schemas:", err);
      setSchemas([]);
      setSchemasError(
        err instanceof Error ? err.message : "Failed to load schemas",
      );
    } finally {
      setSchemasLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void window.electronAPI.papr.checkLoginStatus().then((r) => {
      if (!alive) return;
      const ok = !!(r.success && r.isLoggedIn);
      setLoggedIn(ok);
      if (ok) void loadSchemas();
    }).catch(() => undefined);
    const reload = () => { setSchemas([]); void loadSchemas(); };
    window.addEventListener("papr-workspace-switch-complete", reload);
    return () => { alive = false; window.removeEventListener("papr-workspace-switch-complete", reload); };
  }, [loadSchemas]);

  if (!loggedIn) return null;
  return (
    <SchemasSection
      schemas={schemas}
      loading={schemasLoading}
      error={schemasError}
      expandedSchema={expandedSchema}
      onToggleSchema={setExpandedSchema}
      onRefresh={() => void loadSchemas()}
    />
  );
}

function SchemasSection({
  schemas,
  loading,
  error,
  expandedSchema,
  onToggleSchema,
  onRefresh,
  namespaceName,
}: {
  schemas: SchemaInfo[];
  loading: boolean;
  error?: string | null;
  expandedSchema: string | null;
  onToggleSchema: (id: string | null) => void;
  onRefresh: () => void;
  namespaceName?: string;
}) {
  const [isCollapsed, setIsCollapsed] = useState(true);

  const activeSchemas = schemas.filter(s => s.status === "active");
  const draftSchemas = schemas.filter(s => s.status === "draft");
  const otherSchemas = schemas.filter(s => s.status !== "active" && s.status !== "draft");

  return (
    <div className="papr-schemas">
      <div className="papr-schemas__header">
        <button
          className="papr-schemas__toggle"
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          <svg
            className={`papr-schemas__chevron ${!isCollapsed ? "papr-schemas__chevron--open" : ""}`}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <h4 className="papr-schemas__title">
            Schemas
            {schemas.length > 0 && (
              <span className="papr-schemas__count-badge">{schemas.length}</span>
            )}
            {namespaceName && (
              <span className="papr-schemas__ns-badge">{namespaceName}</span>
            )}
          </h4>
        </button>
        <button
          className="papr-schemas__refresh"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh schemas"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={loading ? "papr-spinner" : ""}
          >
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
          </svg>
        </button>
      </div>

      {!isCollapsed && (
        <>
          {loading && schemas.length === 0 && !error && (
            <div className="papr-schemas__empty">Loading schemas...</div>
          )}

          {error && (
            <div className="papr-schemas__empty papr-schemas__empty--error">
              {error}
            </div>
          )}

          {!loading && schemas.length === 0 && !error && (
            <div className="papr-schemas__empty">
              No schemas in this namespace. The agent can create schemas using <code>register_schema</code>.
            </div>
          )}

          {schemas.length > 0 && (
            <div className="papr-schemas__list">
              {[...activeSchemas, ...draftSchemas, ...otherSchemas].map((schema) => (
                <SchemaCard
                  key={schema.id}
                  schema={schema}
                  isExpanded={expandedSchema === schema.id}
                  onToggle={() => onToggleSchema(expandedSchema === schema.id ? null : schema.id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SchemaCard({
  schema,
  isExpanded,
  onToggle,
}: {
  schema: SchemaInfo;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`papr-schema-card ${isExpanded ? "papr-schema-card--expanded" : ""}`}>
      <button className="papr-schema-card__header" onClick={onToggle}>
        <div className="papr-schema-card__info">
          <span className="papr-schema-card__name">{schema.name}</span>
          <span className={`papr-schema-card__status papr-schema-card__status--${schema.status}`}>
            {schema.status}
          </span>
        </div>
        <div className="papr-schema-card__meta">
          <span className="papr-schema-card__count">{schema.nodeTypeCount} types</span>
          <span className="papr-schema-card__count">{schema.relationshipTypeCount} rels</span>
          <svg
            className={`papr-schema-card__chevron ${isExpanded ? "papr-schema-card__chevron--open" : ""}`}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
      </button>

      {isExpanded && (
        <div className="papr-schema-card__details">
          {schema.description && (
            <p className="papr-schema-card__description">{schema.description}</p>
          )}

          {schema.nodeTypeNames.length > 0 && (
            <div className="papr-schema-card__section">
              <span className="papr-schema-card__section-label">Node Types</span>
              <div className="papr-schema-card__tags">
                {schema.nodeTypeNames.map((name) => (
                  <span key={name} className="papr-schema-card__tag papr-schema-card__tag--node">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {schema.relationshipTypeNames.length > 0 && (
            <div className="papr-schema-card__section">
              <span className="papr-schema-card__section-label">Relationships</span>
              <div className="papr-schema-card__tags">
                {schema.relationshipTypeNames.map((name) => (
                  <span key={name} className="papr-schema-card__tag papr-schema-card__tag--rel">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {schema.version && (
            <span className="papr-schema-card__version">v{schema.version}</span>
          )}
        </div>
      )}
    </div>
  );
}
