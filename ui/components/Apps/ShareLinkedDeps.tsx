/**
 * Linked apps and databases, shown in Share → "What they can do" under the
 * install-a-copy option. They only matter to people who install a copy: the
 * live app keeps using them, copies don't get them. Informational, never blocks.
 */

import type {
  CloudDatabaseDependencyRef,
  CloudPublishReadinessReport,
} from "../../../src/core/types/cloudAppDependencies";

export interface LinkedDepItem {
  key: string;
  kind: "app" | "db";
  title: string;
  sub: string;
  openAppId?: string;
}

function appStatus(published: boolean, local: boolean): string {
  if (published) return "In Community";
  return local ? "Not in Community yet" : "Not in this workspace";
}

/** Flatten readiness into one row per linked app (with its databases) or orphan database. */
export function linkedDepItems(
  readiness: CloudPublishReadinessReport | null,
): LinkedDepItem[] {
  if (!readiness) return [];
  const apps = readiness.dependencies.apps.filter((dep) => !dep.required);
  const dbsByOwner = new Map<string, CloudDatabaseDependencyRef[]>();
  for (const db of readiness.dependencies.databases) {
    const owner = db.ownerAppId.trim();
    dbsByOwner.set(owner, [...(dbsByOwner.get(owner) ?? []), db]);
  }
  const items: LinkedDepItem[] = apps.map((dep) => {
    const dbs = dbsByOwner.get(dep.appId) ?? [];
    dbsByOwner.delete(dep.appId);
    const uses = dep.enables?.length ? dep.enables.join(", ") : null;
    const dbNames = dbs.map((db) => db.alias ?? db.dbId).join(", ");
    return {
      key: `app-${dep.appId}`,
      kind: "app",
      title: dep.title ?? dep.slug ?? dep.appId,
      sub: [
        uses,
        dbNames && `data: ${dbNames}`,
        appStatus(dep.publishedToCommunity, dep.localAppExists),
      ]
        .filter(Boolean)
        .join(" · "),
      openAppId: dep.localAppExists ? dep.appId : undefined,
    };
  });
  for (const dbs of dbsByOwner.values()) {
    for (const db of dbs) {
      items.push({
        key: `db-${db.dbId}`,
        kind: "db",
        title: db.alias ?? db.dbId,
        sub: `Data from ${db.ownerTitle ?? db.ownerSlug ?? "another app"}`,
      });
    }
  }
  return items;
}

export function linkedDepsSummary(count: number): string {
  return `${count} linked ${count === 1 ? "item" : "items"} not in copies`;
}

const GLYPH = {
  app: "M3 3.5h4v4H3zM9 3.5h4v4H9zM3 9.5h4v4H3zM9 9.5h4v4H9z",
  db: "M3 4c0-1 2.2-1.5 5-1.5S13 3 13 4v8c0 1-2.2 1.5-5 1.5S3 13 3 12V4Zm0 0c0 1 2.2 1.5 5 1.5S13 5 13 4M3 8c0 1 2.2 1.5 5 1.5S13 9 13 8",
};

export function ShareLinkedDeps({
  items,
  onOpenApp,
}: {
  items: LinkedDepItem[];
  onOpenApp?: (appId: string, title?: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="ss6-deps">
      <p className="ss6-deps-lede">
        Copies won&apos;t include {items.length === 1 ? "this" : "these"}. Your
        live app keeps using {items.length === 1 ? "it" : "them"}.
      </p>
      {items.map((item) => (
        <div key={item.key} className="ss6-dep">
          <span className="ss6-dep-ico" aria-hidden>
            <svg viewBox="0 0 16 16" width="13" height="13" focusable="false">
              <path
                d={GLYPH[item.kind]}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="ss6-dep-txt">
            <b>{item.title}</b>
            <small>{item.sub}</small>
          </span>
          {item.openAppId && onOpenApp ? (
            <button
              type="button"
              className="ss6-link-btn"
              onClick={() => onOpenApp(item.openAppId!, item.title)}
            >
              Open
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
