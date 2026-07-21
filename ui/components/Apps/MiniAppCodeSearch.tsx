/**
 * MiniAppCodeSearch — semantic code search via Papr Memory for workspace files.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import type { WorkspaceFileTarget } from "../../hooks/useAppWorkspace";
import type { WorkspaceJobFiles } from "../../hooks/useAppWorkspace";

export interface AppCodeSearchHit {
  memoryId: string;
  fileName: string;
  relativePath: string;
  projectId: string;
  projectType: "mini_app" | "job";
  language?: string;
  snippet: string;
  score?: number;
}

type SearchScope = "all" | "app" | "jobs";

interface MiniAppCodeSearchProps {
  appId: string;
  jobs: WorkspaceJobFiles[];
  onOpenHit: (target: WorkspaceFileTarget) => void;
}

function hitToTarget(
  appId: string,
  hit: AppCodeSearchHit,
): WorkspaceFileTarget {
  if (hit.projectType === "mini_app") {
    return {
      scope: "app",
      appId,
      path: hit.relativePath,
      kind: "file",
      readOnly: false,
    };
  }
  return {
    scope: "job",
    jobId: hit.projectId,
    path: hit.relativePath,
    kind: "file",
    readOnly: false,
  };
}

export function MiniAppCodeSearch({
  appId,
  jobs,
  onOpenHit,
}: MiniAppCodeSearchProps) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [jobFilter, setJobFilter] = useState<string | null>(null);
  const [hits, setHits] = useState<AppCodeSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const jobIds = useMemo(() => jobs.map((job) => job.jobId), [jobs]);

  const runSearch = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      if (!trimmed) {
        setHits([]);
        setError(null);
        setNotice(null);
        setHasSearched(false);
        return;
      }

      setSearching(true);
      setError(null);
      setNotice(null);
      setHasSearched(true);

      try {
        const resp = await gateway.send("app:search-code", {
          appId,
          query: trimmed,
          jobIds,
          scope: jobFilter ? "jobs" : scope,
          jobFilter: jobFilter ? [jobFilter] : undefined,
          limit: 15,
        });
        const data = resp.data as {
          hits?: AppCodeSearchHit[];
          notice?: string;
        };
        setHits(data.hits ?? []);
        setNotice(data.notice ?? null);
      } catch (err) {
        setHits([]);
        setNotice(null);
        setError((err as Error).message);
      } finally {
        setSearching(false);
      }
    },
    [appId, jobIds, jobFilter, scope],
  );

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setError(null);
      setNotice(null);
      setHasSearched(false);
      return;
    }

    const timer = window.setTimeout(() => {
      void runSearch(query);
    }, 350);

    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  const showResults = hasSearched && query.trim().length > 0;

  return (
    <div className="mini-app-code-search">
      <div className="mini-app-code-search__bar">
        <svg
          className="mini-app-code-search__icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.75" />
          <path
            d="M20 20l-3.5-3.5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
        <input
          type="search"
          className="mini-app-code-search__input"
          placeholder="Search code…"
          value={query}
          aria-label="Search app code"
          onChange={(event) => setQuery(event.target.value)}
        />
        {searching ? (
          <span className="mini-app-code-search__status">Searching…</span>
        ) : null}
      </div>

      <div className="mini-app-code-search__filters" role="group" aria-label="Search scope">
        <button
          type="button"
          className={
            scope === "all" && !jobFilter
              ? "mini-app-code-search__filter mini-app-code-search__filter--active"
              : "mini-app-code-search__filter"
          }
          onClick={() => {
            setScope("all");
            setJobFilter(null);
          }}
        >
          All
        </button>
        <button
          type="button"
          className={
            scope === "app" && !jobFilter
              ? "mini-app-code-search__filter mini-app-code-search__filter--active"
              : "mini-app-code-search__filter"
          }
          onClick={() => {
            setScope("app");
            setJobFilter(null);
          }}
        >
          App
        </button>
        {jobs.map((job) => (
          <button
            key={job.jobId}
            type="button"
            className={
              jobFilter === job.jobId
                ? "mini-app-code-search__filter mini-app-code-search__filter--active"
                : "mini-app-code-search__filter"
            }
            title={job.jobId}
            onClick={() => {
              setScope("jobs");
              setJobFilter(job.jobId);
            }}
          >
            {job.name}
          </button>
        ))}
      </div>

      {notice ? <p className="mini-app-code-search__notice">{notice}</p> : null}

      {error ? <p className="mini-app-code-search__error">{error}</p> : null}

      {showResults && !searching && !error && hits.length === 0 ? (
        <p className="mini-app-code-search__empty">No matching code found.</p>
      ) : null}

      {showResults && hits.length > 0 ? (
        <ul className="mini-app-code-search__results">
          {hits.map((hit) => (
            <li key={`${hit.projectId}:${hit.relativePath}`}>
              <button
                type="button"
                className="mini-app-code-search__result"
                onClick={() => onOpenHit(hitToTarget(appId, hit))}
              >
                <span className="mini-app-code-search__result-head">
                  <span className="mini-app-code-search__result-file">
                    {hit.fileName}
                  </span>
                  {hit.projectType === "job" ? (
                    <span className="mini-app-files__job-badge">Job</span>
                  ) : null}
                  {hit.language ? (
                    <span className="mini-app-code-search__result-lang">
                      {hit.language}
                    </span>
                  ) : null}
                </span>
                <span className="mini-app-code-search__result-path">
                  {hit.relativePath}
                </span>
                <span className="mini-app-code-search__result-snippet">
                  {hit.snippet}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
