/** Share bar v2 Settings page: grouped list, sections by role, actions go to the bar. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../components/Apps/AppJobsPanel", () => ({ AppJobsPanel: () => <div>jobs-panel</div> }));
vi.mock("../../components/Apps/MiniAppFilesView", () => ({ MiniAppFilesView: ({ panel }: { panel: string }) => <div>files-view:{panel}</div> }));
vi.mock("../../utils/cloudAppRequirementsApi", () => ({ fetchAppRequirements: vi.fn(async () => ({ requirements: [] })) }));
vi.mock("../../hooks/useMissingAppKeys", () => ({ openKeySettings: vi.fn() }));

import { AppSettingsPage, APP_SETTINGS_ACTION_EVENT, settingsItems } from "../../components/Apps/AppSettingsPage";

const ctx = { collaborator: false, live: true, onTeamData: false, loggedIn: true, liveRunsOn: "local" as const, onLiveRunsOnChange: vi.fn() };

describe("AppSettingsPage", () => {
  it("owner sees every group; a teammate's copy hides owner-only sections", () => {
    expect(settingsItems({ collaborator: false }).map((i) => i.id)).toEqual(
      ["code", "data", "jobs", "general", "versions", "access", "web", "runs", "files", "keys", "advanced"]);
    expect(settingsItems({ collaborator: true }).map((i) => i.id)).toEqual(["code", "data", "jobs", "runs", "files", "keys", "advanced"]);
  });

  it("Build items open the existing panels; section change is reported", () => {
    const onSection = vi.fn();
    render(<AppSettingsPage appId="a1" section="data" onSectionChange={onSection} ctx={ctx} />);
    expect(screen.getByText("files-view:db")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Where Live runs/ }));
    expect(onSection).toHaveBeenCalledWith("runs");
  });

  it("row actions are sent to the publish bar as events", () => {
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(APP_SETTINGS_ACTION_EVENT, on);
    render(<AppSettingsPage appId="a1" section="web" onSectionChange={vi.fn()} ctx={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    window.removeEventListener(APP_SETTINGS_ACTION_EVENT, on);
    expect(seen).toEqual([{ appId: "a1", action: "copy-link" }]);
  });

  it("Where Live runs switches, and Web is off until published", () => {
    const onRuns = vi.fn();
    const { rerender } = render(<AppSettingsPage appId="a1" section="runs" onSectionChange={vi.fn()} ctx={{ ...ctx, onLiveRunsOnChange: onRuns }} />);
    fireEvent.click(screen.getByRole("button", { name: "Use Web" }));
    expect(onRuns).toHaveBeenCalledWith("published");
    rerender(<AppSettingsPage appId="a1" section="runs" onSectionChange={vi.fn()} ctx={{ ...ctx, live: false }} />);
    expect((screen.getByRole("button", { name: "Use Web" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
