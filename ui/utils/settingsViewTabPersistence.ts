/**
 * Persist Settings section across sidebar navigation.
 * SettingsView unmounts when leaving Settings — sessionStorage keeps the last section.
 */

import type { SettingsTab } from "../types/settings";

const STORAGE_KEY = "papr-settings-view-tab";

const VALID_TABS: ReadonlySet<SettingsTab> = new Set([
  "models",
  "keys",
  "cloud",
  "databases",
  "platforms",
  "profile",
  "permissions",
  "privacy",
  "migration",
  "about",
]);

export function readSettingsViewTab(): SettingsTab | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw && VALID_TABS.has(raw as SettingsTab)) {
      return raw as SettingsTab;
    }
  } catch {
    /* private browsing / quota */
  }
  return null;
}

export function writeSettingsViewTab(tab: SettingsTab): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, tab);
  } catch {
    /* noop */
  }
}
