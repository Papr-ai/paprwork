/**
 * Open or focus the Settings tab (e.g. after workspace switch).
 */

import { useTabStore } from "../stores/tabStore";
import type { SettingsTab } from "../types/settings";

export function ensureSettingsTab(options?: { section?: SettingsTab }): string {
  const { tabs, createTab, switchToTab } = useTabStore.getState();
  const existing = tabs.find(
    (tab) => tab.type === "settings" && tab.entityId === "settings",
  );
  const tabId =
    existing?.id ?? createTab("settings", "settings", "Settings");
  switchToTab(tabId);

  if (options?.section && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("papr:open-settings", {
        detail: { tab: options.section },
      }),
    );
  }

  return tabId;
}
