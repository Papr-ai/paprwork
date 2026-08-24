/**
 * Persist Apps library sub-tab (My apps / Team / Community) across sidebar navigation.
 * AppsView unmounts when leaving the Apps tab — sessionStorage keeps the last selection.
 */

export type AppsViewTab = "my-apps" | "namespace-community" | "community";

const STORAGE_KEY = "papr-apps-view-tab";

const VALID_TABS: ReadonlySet<AppsViewTab> = new Set([
  "my-apps",
  "namespace-community",
  "community",
]);

export function readAppsViewTab(): AppsViewTab | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw && VALID_TABS.has(raw as AppsViewTab)) {
      return raw as AppsViewTab;
    }
  } catch {
    /* private browsing / quota */
  }
  return null;
}

export function writeAppsViewTab(tab: AppsViewTab): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, tab);
  } catch {
    /* noop */
  }
}
