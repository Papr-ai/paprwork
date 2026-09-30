import { describe, expect, it } from "vitest";
import { useSettingsNavigationStore } from "../ui/stores/settingsNavigationStore";

describe("settingsNavigationStore", () => {
  it("queues billing plan focus until acknowledged", () => {
    useSettingsNavigationStore.setState({
      token: 0,
      pendingTab: null,
      pendingPlanFocus: false,
    });

    useSettingsNavigationStore.getState().navigate({
      tab: "billing",
      focusPlan: true,
    });

    const afterNavigate = useSettingsNavigationStore.getState();
    expect(afterNavigate.pendingTab).toBe("billing");
    expect(afterNavigate.pendingPlanFocus).toBe(true);
    expect(afterNavigate.token).toBe(1);

    afterNavigate.acknowledgeTab();
    expect(useSettingsNavigationStore.getState().pendingTab).toBeNull();
    expect(useSettingsNavigationStore.getState().pendingPlanFocus).toBe(true);

    afterNavigate.acknowledgePlanFocus();
    expect(useSettingsNavigationStore.getState().pendingPlanFocus).toBe(false);
  });
});
