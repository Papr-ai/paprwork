import React, { useCallback, useState } from "react";
import type { CloudPublishReadinessReport } from "../../src/core/types/cloudAppDependencies";
import "./CloudPublishDependenciesPanel.css";

interface CloudPublishDependenciesPanelProps {
  readiness: CloudPublishReadinessReport | null;
  loading?: boolean;
  onOpenDependencyApp?: (appId: string, title?: string) => void;
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

  if (loading) {
    return (
      <div className="share-sheet__notice share-sheet__notice--info">
        <p>Checking linked dependencies…</p>
      </div>
    );
  }
  if (!readiness) return null;

  const optionalApps = readiness.dependencies.apps.filter((dep) => !dep.required);
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
          <p>
            Installers who only install this app will not get everything below.
            Publish each linked app separately if you want those features available
            in Community Apps.
          </p>
          <ul className="cloud-deps-panel__deps">
            {optionalApps.map((dep) => {
              const label = dep.title ?? dep.slug ?? dep.appId;
              const enables =
                dep.enables && dep.enables.length > 0
                  ? dep.enables.join(", ")
                  : "extra features";
              let status = "Not in this workspace";
              if (dep.publishedToCommunity) {
                status = "Published to Community";
              } else if (dep.localAppExists) {
                status = "In workspace — not listed in Community yet";
              }
              return (
                <li key={dep.appId} className="cloud-deps-panel__dep">
                  <div className="cloud-deps-panel__dep-main">
                    <strong>{label}</strong>
                    <span className="cloud-deps-panel__dep-enables">
                      Enables: {enables}
                    </span>
                    <span className="cloud-deps-panel__dep-status">{status}</span>
                  </div>
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
            })}
            {readiness.dependencies.databases.map((dbDep) => (
              <li key={dbDep.dbId} className="cloud-deps-panel__dep">
                <div className="cloud-deps-panel__dep-main">
                  <strong>{dbDep.alias ?? dbDep.dbId}</strong>
                  <span className="cloud-deps-panel__dep-enables">
                    Owned by{" "}
                    {dbDep.ownerTitle ?? dbDep.ownerSlug ?? dbDep.ownerAppId}
                  </span>
                </div>
              </li>
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
