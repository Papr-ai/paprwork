/**
 * demoSeedTabs — makes the web demo open on a Chat tab instead of the
 * "No tab selected" empty state.
 *
 * Why: the tab store only persists `activeTabId` (not `activeLeftTab`), and
 * on a fresh demo session there are no tabs at all — so ContentArea renders
 * "No tab selected" while the sidebar still highlights Chat (its default).
 *
 * No-op unless VITE_DEMO_MODE === "1". Runs synchronously before React mounts
 * (zustand `persist` hydrates on store import), so the first paint is correct.
 */
import { useTabStore } from "../../stores/tabStore";

export function seedDemoTabs(): void {
  if (import.meta.env.VITE_DEMO_MODE !== "1") return;

  // Skip the first-run onboarding flow so the demo opens straight into Chat
  // (App auto-opens a "Getting Started" tab while onboarding !== completed).
  try {
    localStorage.setItem(
      "papr-onboarding-state",
      JSON.stringify({
        version: 2,
        phase: "completed",
        intent: null,
        modelConnected: true,
        firstChatSent: true,
        firstResultCreated: true,
        dismissedAt: new Date().toISOString(),
      }),
    );
  } catch {
    /* localStorage unavailable — non-fatal */
  }

  const store = useTabStore.getState();

  // Fresh session — open a Chat tab so the demo starts in Chat.
  if (store.tabs.length === 0) {
    store.createTab("chat", "demo-welcome", "New Chat");
    return;
  }

  // Returning session (persisted tabs) but no active pane restored — the store
  // only persists `activeTabId`, not `activeLeftTab`, and `activeTabId` may even
  // be null. Re-activate the persisted active tab (or the most recent one) so a
  // pane always renders instead of "No tab selected".
  if (!store.activeLeftTab) {
    const target = store.activeTabId || store.tabs[store.tabs.length - 1]?.id;
    if (target) store.switchToTab(target);
  }
}
