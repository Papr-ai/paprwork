/**
 * Open or focus the Settings tab (e.g. after workspace switch).
 */

import { useSettingsNavigationStore } from "../stores/settingsNavigationStore";
import { useTabStore } from "../stores/tabStore";
import type { SettingsTab } from "../types/settings";

export function ensureSettingsTab(options?: {
  section?: SettingsTab;
  focusPlan?: boolean;
}): string {
  const { tabs, createTab, switchToTab } = useTabStore.getState();
  const existing = tabs.find(
    (tab) => tab.type === "settings" && tab.entityId === "settings",
  );
  const tabId =
    existing?.id ?? createTab("settings", "settings", "Settings");
  switchToTab(tabId);

  if (options?.section || options?.focusPlan) {
    useSettingsNavigationStore.getState().navigate({
      tab: options.section,
      focusPlan: options.focusPlan,
    });
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("papr:open-settings", {
        detail: {
          tab: options?.section,
          focusPlan: options?.focusPlan,
        },
      }),
    );
    if (options?.focusPlan) {
      window.dispatchEvent(new CustomEvent("papr:focus-plan-section"));
    }
  }

  return tabId;
}
