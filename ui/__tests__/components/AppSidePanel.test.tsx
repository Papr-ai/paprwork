/**
 * AppSidePanel + AppJobsPanel: Data & code beside the app, and the Jobs tab
 * grouped into Scheduled / One off.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JobRecord } from "../../hooks/useJobs";

const runJob = vi.fn();
const loadLogs = vi.fn();

function job(p: Partial<JobRecord> & Pick<JobRecord, "id" | "name">): JobRecord {
  return {
    type: "python",
    status: "completed",
    appIds: ["app-1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...p,
  };
}

const JOBS: JobRecord[] = [
  job({ id: "gh", name: "Graph Harvester", schedule: { enabled: true, cron: "0 10 * * *" } }),
  job({ id: "rd", name: "Reply Detector", dependsOn: [{ jobId: "gh", onStatus: "completed" }] }),
  job({ id: "ss", name: "Search Scraper", status: "failed", error: "KeyError: 'severity'" }),
  job({ id: "dr", name: "Reply Drafter", type: "agent" }),
  job({ id: "bf", name: "Backfill history" }),
];

vi.mock("../../hooks/useJobs", () => ({
  useJobs: () => ({
    jobs: JOBS,
    graph: {
      version: 1,
      updatedAt: "",
      folders: {},
      appLinks: { "app-1": { name: "LinkedIn", jobIds: JOBS.map((j) => j.id) } },
      edges: [{ from: "gh", to: "rd", onStatus: "completed" }],
    },
    graphLoaded: true,
    loading: false,
    error: null,
    runJob,
    stopJob: vi.fn(),
    loadLogs,
    logsByJobId: {},
  }),
}));

const openChat = vi.fn();
vi.mock("../../utils/openCloudSyncAgentChat", () => ({
  openCloudSyncAgentChat: (...args: unknown[]) => openChat(...args),
}));

vi.mock("../../components/Apps/MiniAppFilesView", () => ({
  MiniAppFilesView: ({ panel }: { panel: string }) => <div data-testid="files-view">{panel}</div>,
}));

import { AppSidePanel } from "../../components/Apps/AppSidePanel";

function renderPanel(over: Partial<Parameters<typeof AppSidePanel>[0]> = {}) {
  const props = {
    appId: "app-1",
    tab: "jobs" as const,
    wide: false,
    onTabChange: vi.fn(),
    onWideChange: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<AppSidePanel {...props} />);
  return props;
}

describe("AppSidePanel", () => {
  beforeEach(() => {
    runJob.mockReset();
    openChat.mockReset();
  });

  it("beside the app: tabs, full width and close, no back button", () => {
    const props = renderPanel();
    expect(screen.getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual([
      "Data",
      "Jobs",
      "Code",
      "Files",
    ]);
    expect(screen.queryByText("App")).toBeNull();
    fireEvent.click(screen.getByLabelText("Full width"));
    expect(props.onWideChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("full width: ‹ App sits left of the tabs and goes back to side by side", () => {
    const props = renderPanel({ wide: true });
    const back = screen.getByTitle("Back to side by side");
    const head = back.parentElement!;
    const kids = [...head.children];
    expect(kids.indexOf(back)).toBeLessThan(kids.indexOf(head.querySelector(".asp-tabs")!));
    fireEvent.click(back);
    expect(props.onWideChange).toHaveBeenCalledWith(false);
  });

  it("Data tab shows the database view", () => {
    renderPanel({ tab: "data" });
    expect(screen.getByTestId("files-view").textContent).toBe("db");
  });

  it("Jobs: Scheduled and One off, each job once", async () => {
    renderPanel({ wide: true });
    await waitFor(() => expect(screen.getByRole("region", { name: "One off" })).toBeTruthy());
    const names = (section: string) =>
      [...screen.getByRole("region", { name: section }).querySelectorAll(".wf-node-title")].map(
        (n) => n.textContent,
      );
    expect(names("Scheduled")).toEqual(["Graph Harvester", "Reply Detector"]);
    expect(names("One off").sort()).toEqual(["Backfill history", "Reply Drafter", "Search Scraper"]);
    expect(screen.queryByText("From the app")).toBeNull();
    expect(document.querySelectorAll(".wf-edge")).toHaveLength(1);
  });

  it("agent jobs use the agent glyph", async () => {
    renderPanel({ wide: true });
    await waitFor(() => screen.getByRole("region", { name: "One off" }));
    const card = document.querySelector('[data-job-id="dr"]')!;
    expect(card.querySelector(".agent-glyph")).toBeTruthy();
  });

  it("failed job is red; clicking it shows the error and Ask Pen to fix", async () => {
    renderPanel({ wide: true });
    await waitFor(() => screen.getByRole("region", { name: "One off" }));
    const card = document.querySelector('[data-job-id="ss"]') as HTMLElement;
    expect(card.className).toContain("ajp-card--failed");
    expect(screen.queryByText("Ask Pen to fix")).toBeNull();
    fireEvent.click(card);
    const detail = screen.getByRole("dialog", { name: "Search Scraper" });
    expect(within(detail).getByText(/KeyError/)).toBeTruthy();
    fireEvent.click(within(detail).getByText("Ask Pen to fix"));
    expect(openChat).toHaveBeenCalledWith(expect.stringContaining("Search Scraper"), expect.anything());
  });

  it("focusJobId (the Job failing chip) opens that job's details", async () => {
    renderPanel({ wide: true, focusJobId: "ss" });
    const detail = await screen.findByRole("dialog", { name: "Search Scraper" });
    expect(within(detail).getByText("Ask Pen to fix")).toBeTruthy();
    expect(loadLogs).toHaveBeenCalledWith("ss");
  });

  it("beside the app: compact cards have no run button", async () => {
    renderPanel({ wide: false });
    await waitFor(() => screen.getByRole("region", { name: "Scheduled" }));
    expect(document.querySelector(".wf-node-action")).toBeNull();
    expect(document.querySelector(".ajp--compact")).toBeTruthy();
  });

  it("the job details are a modal: Escape closes it", async () => {
    renderPanel({ wide: true, focusJobId: "ss" });
    await screen.findByRole("dialog", { name: "Search Scraper" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search Scraper" })).toBeNull());
  });
});

describe("latestRunLog", () => {
  it("keeps only the last run", async () => {
    const { latestRunLog } = await import("../../components/Apps/AppJobsPanel");
    const log = [
      "[t1] [attempt 1/1] Waiting for execution capacity run-a",
      "[t1] manual-ok",
      "[t2] [attempt 1/1] Waiting for execution capacity run-b",
      "[t2] boom",
    ].join("\n");
    expect(latestRunLog(log)).toBe(
      "[t2] [attempt 1/1] Waiting for execution capacity run-b\n[t2] boom",
    );
    expect(latestRunLog("plain text")).toBe("plain text");
  });
});
