/**
 * Per-workspace tab + UI state persistence (SQLite via gateway).
 */

import { useTabStore } from "../stores/tabStore";
import type { TabType } from "../types/tabs";
import { isCatalogPreviewEntityId } from "../types/cloudCatalogPreviewTab";
import { gateway } from "../src/lib/gateway";
import { ensureDefaultChatTab, ensureDefaultHomeTab } from "./ensureDefaultChatTab";
import { ensureSettingsTab } from "./ensureSettingsTab";
import { serializeTabForGatewayPersistence } from "./tabPersistenceMetadata";

interface TabRow {
  id: string;
  type: string;
  entityId: string;
  title: string;
  displayMode: string;
  parentTabId: string | null;
  position: number;
  isFavorite: boolean;
  metadata?: Record<string, unknown>;
}

/** Save open tabs + navigation state to the current workspace before switching away. */
export async function flushWorkspaceStateToGateway(): Promise<void> {
  const {
    tabs: rawTabs,
    activeTabId,
    splitRatio,
    splitRatios,
    history,
    historyIndex,
  } = useTabStore.getState();

  const tabs = normalizeTabHierarchy(rawTabs);

  const tabsToSave = tabs.map((tab, index) => serializeTabForGatewayPersistence(tab, index));

  await gateway.send("app:save_tabs", tabsToSave);

  const onboardingStep1 = localStorage.getItem("papr-onboarding-step1") === "true";
  const onboardingStep2 = localStorage.getItem("papr-onboarding-step2") === "true";
  const onboardingDismissed =
    localStorage.getItem("papr-onboarding-dismissed") === "true";

  await gateway.send("app:save_state", {
    activeTabId,
    splitRatio,
    splitRatios,
    history,
    historyIndex,
    onboardingStep1Completed: onboardingStep1,
    onboardingStep2Completed: onboardingStep2,
    onboardingStep3Completed: false,
    onboardingDismissed,
    lastSavedAt: new Date().toISOString(),
  });
}

export interface WorkspaceEntityIdSets {
  validChatIds?: Set<string>;
  validAppIds?: Set<string>;
  validDocumentIds?: Set<string>;
}

export interface ApplyPersistedAppStateOptions extends WorkspaceEntityIdSets {
  /** When restored workspace has no valid active tab. Default: open Home. */
  emptyActiveTabFallback?: "chat" | "home" | "settings" | "none";
}

export interface PersistedAppStateSnapshot {
  tabs: ReturnType<typeof mapTabRow>[];
  activeTabId: string | null;
  splitRatio: number;
  splitRatios: Record<string, number>;
  history: string[];
  historyIndex: number;
}

/** Fetch tab metadata + navigation state from workspace SQLite (no store writes). */
export async function fetchPersistedAppStateFromGateway(): Promise<PersistedAppStateSnapshot | null> {
  const tabsResponse = (await gateway.send("app:load_tabs", {})) as {
    success?: boolean;
    data?: TabRow[];
  };

  let restoredTabs: ReturnType<typeof mapTabRow>[] = [];

  if (
    tabsResponse.success &&
    Array.isArray(tabsResponse.data) &&
    tabsResponse.data.length > 0
  ) {
    restoredTabs = tabsResponse.data.map(mapTabRow);

    const tabMap = new Map(restoredTabs.map((t) => [t.id, t]));
    for (const tab of restoredTabs) {
      if (tab.parentTabId) {
        if (tab.parentTabId === tab.id) {
          tab.parentTabId = null;
          continue;
        }
        const parent = tabMap.get(tab.parentTabId);
        if (parent && !parent.childTabIds.includes(tab.id)) {
          parent.childTabIds.push(tab.id);
        }
      }
    }
  }

  const stateResponse = (await gateway.send("app:load_state", {})) as {
    success?: boolean;
    data?: {
      activeTabId?: string | null;
      splitRatio?: number;
      splitRatios?: Record<string, number>;
      history?: string[];
      historyIndex?: number;
      onboardingStep1Completed?: boolean;
      onboardingStep2Completed?: boolean;
      onboardingDismissed?: boolean;
    };
  };

  const restoredIds = new Set(restoredTabs.map((t) => t.id));
  let activeTabId: string | null = null;
  let splitRatio = 0.5;
  let splitRatios: Record<string, number> = {};
  let history: string[] = [];
  let historyIndex = -1;

  if (stateResponse.success && stateResponse.data) {
    const state = stateResponse.data;
    activeTabId =
      state.activeTabId && restoredIds.has(state.activeTabId)
        ? state.activeTabId
        : restoredTabs[0]?.id ?? null;
    splitRatio = state.splitRatio ?? 0.5;
    splitRatios = state.splitRatios ?? {};
    history = (state.history ?? []).filter((id) => restoredIds.has(id));
    historyIndex = state.historyIndex ?? -1;

    const onboarding = state as {
      onboardingStep1Completed?: boolean;
      onboardingStep2Completed?: boolean;
      onboardingDismissed?: boolean;
    };
    if (onboarding.onboardingStep1Completed !== undefined) {
      localStorage.setItem(
        "papr-onboarding-step1",
        onboarding.onboardingStep1Completed ? "true" : "false",
      );
    }
    if (onboarding.onboardingStep2Completed !== undefined) {
      localStorage.setItem(
        "papr-onboarding-step2",
        onboarding.onboardingStep2Completed ? "true" : "false",
      );
    }
    if (onboarding.onboardingDismissed !== undefined) {
      localStorage.setItem(
        "papr-onboarding-dismissed",
        onboarding.onboardingDismissed ? "true" : "false",
      );
    }
  } else {
    activeTabId = restoredTabs[0]?.id ?? null;
  }

  return {
    tabs: restoredTabs,
    activeTabId,
    splitRatio,
    splitRatios,
    history,
    historyIndex,
  };
}

type TabHierarchyFields = {
  id: string;
  displayMode: "standalone" | "parent" | "child";
  parentTabId: string | null;
  childTabIds: string[];
  position?: "left" | "right";
};

/**
 * Fix tabs left in an invalid hierarchy (e.g. displayMode "child" with no parent).
 * Orphan children are hidden from the tab bar but still render full-screen — promote them.
 */
export function normalizeTabHierarchy<T extends TabHierarchyFields>(tabs: T[]): T[] {
  const tabIds = new Set(tabs.map((tab) => tab.id));

  let normalized = tabs.map((tab) => {
    const parentMissing = tab.parentTabId !== null && !tabIds.has(tab.parentTabId);
    const orphanChild =
      tab.displayMode === "child" && (tab.parentTabId === null || parentMissing);

    if (orphanChild) {
      return {
        ...tab,
        parentTabId: null,
        displayMode: "standalone" as const,
        position: undefined,
      };
    }

    if (parentMissing) {
      return {
        ...tab,
        parentTabId: null,
        displayMode: tab.displayMode === "child" ? ("standalone" as const) : tab.displayMode,
        position: undefined,
      };
    }

    return tab;
  });

  normalized = normalized.map((tab) => {
    const validChildIds = tab.childTabIds.filter((childId) => tabIds.has(childId));
    if (tab.displayMode === "parent" && validChildIds.length === 0) {
      return {
        ...tab,
        childTabIds: [],
        displayMode: "standalone" as const,
      };
    }
    if (validChildIds.length !== tab.childTabIds.length) {
      return { ...tab, childTabIds: validChildIds };
    }
    return tab;
  });

  return normalized;
}

/** Preserve in-memory tabs not yet written to SQLite (debounced save). */
export function mergeLocalTabsIntoSnapshot(
  snapshot: PersistedAppStateSnapshot,
  localTabs: PersistedAppStateSnapshot["tabs"],
  localActiveTabId: string | null,
): PersistedAppStateSnapshot {
  const persistedIds = new Set(snapshot.tabs.map((tab) => tab.id));
  const localOnly = localTabs.filter((tab) => !persistedIds.has(tab.id));
  if (localOnly.length === 0) {
    return snapshot;
  }
  return {
    ...snapshot,
    tabs: [...snapshot.tabs, ...localOnly],
    activeTabId: localActiveTabId ?? snapshot.activeTabId,
  };
}

/** Apply fetched tab snapshot to tabStore, optionally pruning stale entity tabs. */
export function applyPersistedAppStateToTabStore(
  snapshot: PersistedAppStateSnapshot,
  options?: ApplyPersistedAppStateOptions,
): void {
  let restoredTabs = snapshot.tabs;

  if (
    options?.validChatIds ||
    options?.validAppIds ||
    options?.validDocumentIds
  ) {
    restoredTabs = pruneStaleEntityTabs(restoredTabs, options);
  }

  restoredTabs = normalizeTabHierarchy(restoredTabs);

  const restoredIds = new Set(restoredTabs.map((t) => t.id));
  let activeTabId = snapshot.activeTabId;
  if (activeTabId && !restoredIds.has(activeTabId)) {
    activeTabId = restoredTabs[0]?.id ?? null;
  }

  const history = snapshot.history.filter((id) => restoredIds.has(id));
  let historyIndex = snapshot.historyIndex;
  if (historyIndex >= history.length) {
    historyIndex = history.length - 1;
  }

  useTabStore.setState({
    tabs: restoredTabs,
    activeTabId,
    splitRatio: snapshot.splitRatio,
    splitRatios: snapshot.splitRatios,
    history,
    historyIndex,
  });

  if (activeTabId) {
    const { switchToTab, getTab } = useTabStore.getState();
    if (getTab(activeTabId)) {
      switchToTab(activeTabId, true);
    }
  }

  if (!useTabStore.getState().activeTabId) {
    const fallback = options?.emptyActiveTabFallback ?? "home";
    if (fallback === "home") {
      ensureDefaultHomeTab();
    } else if (fallback === "chat") {
      ensureDefaultChatTab();
    } else if (fallback === "settings") {
      ensureSettingsTab({ section: "profile" });
    }
  }
}

/** Drop entity tabs whose entityId is not in the active workspace lists. */
export function reconcileEntityTabsInStore(valid: WorkspaceEntityIdSets): void {
  const { activeTabId, tabs, splitRatio, splitRatios, history, historyIndex } =
    useTabStore.getState();
  const activeTab = activeTabId
    ? tabs.find((tab) => tab.id === activeTabId)
    : undefined;
  const stayOnSettings = activeTab?.type === "settings";

  const snapshot: PersistedAppStateSnapshot = {
    tabs,
    activeTabId,
    splitRatio,
    splitRatios,
    history,
    historyIndex,
  };
  applyPersistedAppStateToTabStore(snapshot, {
    ...valid,
    emptyActiveTabFallback: "none",
  });

  if (stayOnSettings) {
    ensureSettingsTab({ section: "profile" });
  }
}

/** Drop chat tabs whose entityId is not in the workspace chat list. */
export function reconcileChatTabsInStore(validChatIds: Set<string>): void {
  reconcileEntityTabsInStore({ validChatIds });
}

/** Load tabs + navigation state for the active workspace from gateway SQLite. */
export async function loadPersistedAppStateFromGateway(
  options?: WorkspaceEntityIdSets,
): Promise<void> {
  const snapshot = await fetchPersistedAppStateFromGateway();
  if (!snapshot) {
    return;
  }
  applyPersistedAppStateToTabStore(snapshot, options);
}

function mapTabRow(tab: TabRow) {
  return {
    id: tab.id,
    type: tab.type as TabType,
    entityId: tab.entityId,
    title: tab.title,
    displayMode: tab.displayMode as "standalone" | "parent" | "child",
    parentTabId: tab.parentTabId,
    childTabIds: [] as string[],
    isFavorite: tab.isFavorite,
    hasUnread: false,
    isStreaming: false,
    ...(tab.metadata ? { metadata: tab.metadata } : {}),
  };
}

export function pruneStaleEntityTabs<
  T extends {
    id: string;
    type: string;
    entityId: string;
    displayMode: "standalone" | "parent" | "child";
    parentTabId: string | null;
    childTabIds: string[];
  },
>(tabs: T[], valid: WorkspaceEntityIdSets): T[] {
  const kept = tabs.filter((tab) => {
    if (tab.type === "chat") {
      return valid.validChatIds?.has(tab.entityId) ?? true;
    }
    if (tab.type === "app") {
      if (isCatalogPreviewEntityId(tab.entityId)) {
        return true;
      }
      return valid.validAppIds?.has(tab.entityId) ?? true;
    }
    if (tab.type === "document") {
      return valid.validDocumentIds?.has(tab.entityId) ?? true;
    }
    return true;
  });
  const keptIds = new Set(kept.map((t) => t.id));
  return normalizeTabHierarchy(
    kept.map((tab) => ({
      ...tab,
      parentTabId:
        tab.parentTabId && keptIds.has(tab.parentTabId) ? tab.parentTabId : null,
      childTabIds: tab.childTabIds.filter((id) => keptIds.has(id)),
    })),
  );
}
