import React, { useCallback, useMemo, useState } from "react";
import type {
  CloudDatabaseDependencyRef,
  CloudDependencyAppStatus,
  CloudPublishReadinessReport,
} from "../../src/core/types/cloudAppDependencies";
import "./CloudPublishDependenciesPanel.css";

interface CloudPublishDependenciesPanelProps {
  readiness: CloudPublishReadinessReport | null;
  loading?: boolean;
  onOpenDependencyApp?: (appId: string, title?: string) => void;
}

function groupDatabasesByOwner(
  databases: CloudDatabaseDependencyRef[],
): Map<string, CloudDatabaseDependencyRef[]> {
  const byOwner = new Map<string, CloudDatabaseDependencyRef[]>();
  for (const db of databases) {
    const key = db.ownerAppId.trim();
    const list = byOwner.get(key);
    if (list) {
      list.push(db);
    } else {
      byOwner.set(key, [db]);
    }
  }
  return byOwner;
}

function appStatusLine(dep: CloudDependencyAppStatus): string {
  if (dep.publishedToCommunity) {
    return "Published to Community";
  }
  if (dep.localAppExists) {
    return "In workspace — not in Community yet";
  }
  return "Not in this workspace";
}

function enablesLine(enables: string[] | undefined, fallback: string): string {
  if (enables && enables.length > 0) {
    return enables.join(", ");
  }
  return fallback;
}

interface DependencyAppBlockProps {
  dep: CloudDependencyAppStatus;
  nestedDbs: CloudDatabaseDependencyRef[];
  onOpenDependencyApp?: (appId: string, title?: string) => void;
}

function DependencyAppBlock({
  dep,
  nestedDbs,
  onOpenDependencyApp,
}: DependencyAppBlockProps) {
  const label = dep.title ?? dep.slug ?? dep.appId;
  const enables = enablesLine(dep.enables, "extra features");

  return (
    <li className="cloud-deps-panel__dep cloud-deps-panel__dep--app">
      <span className="cloud-deps-panel__kind">App</span>
      <p className="cloud-deps-panel__dep-title">{label}</p>
      <p className="cloud-deps-panel__dep-meta">
        <span>Enables: {enables}</span>
        <span className="cloud-deps-panel__dep-meta-sep" aria-hidden>
          ·
        </span>
        <span>{appStatusLine(dep)}</span>
      </p>
      {nestedDbs.length > 0 ? (
        <ul className="cloud-deps-panel__nested" aria-label={`Databases in ${label}`}>
          {nestedDbs.map((dbDep) => (
            <li key={dbDep.dbId} className="cloud-deps-panel__nested-item">
              <span className="cloud-deps-panel__kind cloud-deps-panel__kind--db">
                Database
              </span>
              <span className="cloud-deps-panel__nested-name">
                {dbDep.alias ?? dbDep.dbId}
              </span>
              <span className="cloud-deps-panel__nested-hint">
                Shared with this app
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {dep.localAppExists && onOpenDependencyApp ? (
        <button
          type="button"
          className="share-sheet__secondary-btn cloud-deps-panel__open-btn"
          onClick={() => onOpenDependencyApp(dep.appId, dep.title)}
        >
          Open app
        </button>
      ) : null}
    </li>
  );
}

interface OrphanOwnerDbGroupProps {
  ownerAppId: string;
  ownerTitle?: string;
  ownerSlug?: string;
  databases: CloudDatabaseDependencyRef[];
}

function OrphanOwnerDbGroup({
  ownerAppId,
  ownerTitle,
  ownerSlug,
  databases,
}: OrphanOwnerDbGroupProps) {
  const ownerLabel = ownerTitle ?? ownerSlug ?? ownerAppId;

  return (
    <li className="cloud-deps-panel__dep cloud-deps-panel__dep--app">
      <span className="cloud-deps-panel__kind">App</span>
      <p className="cloud-deps-panel__dep-title">{ownerLabel}</p>
      <p className="cloud-deps-panel__dep-meta">
        Linked database only — publish this app separately for full install.
      </p>
      <ul className="cloud-deps-panel__nested" aria-label={`Databases owned by ${ownerLabel}`}>
        {databases.map((dbDep) => (
          <li key={dbDep.dbId} className="cloud-deps-panel__nested-item">
            <span className="cloud-deps-panel__kind cloud-deps-panel__kind--db">
              Database
            </span>
            <span className="cloud-deps-panel__nested-name">
              {dbDep.alias ?? dbDep.dbId}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function CloudPublishDependenciesPanel({
  readiness,
  loading = false,
  onOpenDependencyApp,
}: CloudPublishDependenciesPanelProps) {
  const [copyDone, setCopyDone] = useState(false);

  const handleCopyNote = useCallback(async () => {
    if (!readiness?.copyInstallNote) return;
    try {
      await navigator.clipboard.writeText(readiness.copyInstallNote);
      setCopyDone(true);
      window.setTimeout(() => setCopyDone(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }, [readiness?.copyInstallNote]);

  const { optionalApps, databasesByOwner, orphanDbGroups } = useMemo(() => {
    if (!readiness) {
      return {
        optionalApps: [] as CloudDependencyAppStatus[],
        databasesByOwner: new Map<string, CloudDatabaseDependencyRef[]>(),
        orphanDbGroups: [] as OrphanOwnerDbGroupProps[],
      };
    }
    const apps = readiness.dependencies.apps.filter((dep) => !dep.required);
    const databasesByOwnerMap = groupDatabasesByOwner(readiness.dependencies.databases);
    const listedAppIds = new Set(apps.map((a) => a.appId));

    const orphans: OrphanOwnerDbGroupProps[] = [];
    for (const [ownerAppId, dbs] of databasesByOwnerMap) {
      if (!listedAppIds.has(ownerAppId)) {
        const first = dbs[0];
        orphans.push({
          ownerAppId,
          ownerTitle: first?.ownerTitle,
          ownerSlug: first?.ownerSlug,
          databases: dbs,
        });
      }
    }

    return {
      optionalApps: apps,
      databasesByOwner: databasesByOwnerMap,
      orphanDbGroups: orphans,
    };
  }, [readiness]);

  if (loading) {
    return (
      <div className="share-sheet__notice share-sheet__notice--info">
        <p>Checking linked dependencies…</p>
      </div>
    );
  }
  if (!readiness) return null;

  const hasOptionalDeps =
    optionalApps.length > 0 || readiness.dependencies.databases.length > 0;
  const hasBlockers = !readiness.ok && readiness.errors.length > 0;
  const hasReconcile = readiness.reconcile.changed;

  if (!hasOptionalDeps && !hasBlockers && !hasReconcile) {
    return null;
  }

  return (
    <div className="share-sheet__section cloud-deps-panel">
      {hasBlockers ? (
        <div className="share-sheet__notice share-sheet__notice--warn cloud-deps-panel__blockers">
          <p className="share-sheet__section-title">Fix before publish</p>
          <p>
            This app&apos;s manifest references resources that are missing from your
            bundle. Fix these before publishing.
          </p>
          <ul className="cloud-deps-panel__list">
            {readiness.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {hasReconcile ? (
        <details className="cloud-deps-panel__reconcile">
          <summary>Manifest will be updated on publish</summary>
          <ul className="cloud-deps-panel__list">
            {readiness.reconcile.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {hasOptionalDeps ? (
        <div className="share-sheet__notice share-sheet__notice--info cloud-deps-panel__optional">
          <p className="share-sheet__section-title">Linked dependencies</p>
          <p className="cloud-deps-panel__intro">
            Installers only get this app unless you also publish linked apps below.
          </p>
          <ul className="cloud-deps-panel__deps">
            {optionalApps.map((dep) => (
              <DependencyAppBlock
                key={dep.appId}
                dep={dep}
                nestedDbs={databasesByOwner.get(dep.appId) ?? []}
                onOpenDependencyApp={onOpenDependencyApp}
              />
            ))}
            {orphanDbGroups.map((group) => (
              <OrphanOwnerDbGroup key={group.ownerAppId} {...group} />
            ))}
          </ul>
          {readiness.copyInstallNote ? (
            <button
              type="button"
              className="share-sheet__secondary-btn"
              onClick={() => void handleCopyNote()}
            >
              {copyDone ? "Copied install note" : "Copy install note for listing"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
