import { useTabStore } from "../stores/tabStore";
import { useSettingsNavigationStore } from "../stores/settingsNavigationStore";

/** True when Settings → Billing is the active view. */
export function useBillingSettingsVisible(): boolean {
  const activeTabId = useTabStore((state) => state.activeTabId);
  const tabs = useTabStore((state) => state.tabs);
  const currentSettingsTab = useSettingsNavigationStore((state) => state.currentTab);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (activeTab?.type !== "settings") {
    return false;
  }

  return currentSettingsTab === "billing";
}
