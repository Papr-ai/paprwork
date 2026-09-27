/**
 * Persist the Apps sidebar section across navigation. AppsView unmounts when
 * leaving the Apps tab — sessionStorage keeps the last selection.
 *
 * Older builds stored tab ids ("my-apps", "namespace-community", "community");
 * those still load and still arrive via the `papr-apps-view-tab` event.
 */
import type { AppsSection } from "./appsLibrary";

/** @deprecated tab ids from the three-tab layout; mapped by toAppsSection. */
export type AppsViewTab = "my-apps" | "namespace-community" | "community";

const STORAGE_KEY = "papr-apps-view-tab";

const SECTIONS: ReadonlySet<string> = new Set<AppsSection>([
  "recent",
  "favorites",
  "live",
  "drafts",
  "automations",
  "attention",
  "archived",
  "team",
  "community",
]);

export function toAppsSection(
  raw: string | null | undefined,
): AppsSection | null {
  if (!raw) return null;
  if (raw === "my-apps") return "recent";
  if (raw === "namespace-community") return "team";
  return SECTIONS.has(raw) ? (raw as AppsSection) : null;
}

export function readAppsSection(): AppsSection | null {
  try {
    return toAppsSection(sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return null; /* private browsing / quota */
  }
}

export function writeAppsSection(section: AppsSection): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, section);
  } catch {
    /* noop */
  }
}
