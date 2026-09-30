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
  "billing",
  "permissions",
  "privacy",
  "migration",
  "about",
  // Dev-only: absent from the whitelist in packaged builds, so a stale "dev"
  // value is rejected and falls back to Profile rather than a blank panel.
  ...(import.meta.env.DEV ? (["dev"] as const) : []),
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
