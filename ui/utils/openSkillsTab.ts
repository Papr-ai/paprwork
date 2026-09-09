import type { TabType } from "../types/tabs";

export type SkillsTabView = "marketplace" | "installed";

export function openSkillsTab(
  createTab: (
    type: TabType,
    entityId: string,
    title: string,
    metadata?: Record<string, unknown>,
  ) => string,
  switchToTab: (tabId: string) => void,
  view: SkillsTabView = "marketplace",
): string {
  const tabId = createTab("skills", "skills", "Skills", { skillsView: view });
  switchToTab(tabId);
  window.dispatchEvent(
    new CustomEvent("papr:open-skills", { detail: { view } }),
  );
  return tabId;
}
