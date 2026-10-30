/**
 * Publish bar: Share is shown on drafts too (publishes first, then opens the
 * share sheet), and the URL row is gone (Refresh lives in the overflow).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../hooks/useAppCloudSyncStatus", () => ({
  useAppCloudSyncStatus: () => ({
    status: null, gitSyncEnabled: null, globalAutoUploadEnabled: false, loading: false,
    refreshing: false, pushing: false, pulling: false, applyingUpdates: false, error: null,
    lastCheckedAt: null, publisherUpdatesAvailable: false, updatesPaused: null,
    pushNow: vi.fn(async () => {}), pullUpdates: vi.fn(async () => true),
    checkStatus: vi.fn(), refresh: vi.fn(),
  }),
}));
vi.mock("../../hooks/useMissingAppKeys", () => ({
  useMissingAppKeys: () => [], openKeySettings: vi.fn(), useRequirementsChangedTick: () => 0,
}));
vi.mock("../../hooks/usePaprNamespace", () => ({
  usePaprNamespace: () => ({ isLoggedIn: false, workspaceName: null, namespaceName: null }),
}));
vi.mock("../../hooks/useIncomingCloudChangeRequests", () => ({
  useIncomingCloudChangeRequests: () => ({
    requests: [], pending: [], open: [], loading: false, error: null, reload: vi.fn(async () => {}),
  }),
}));
vi.mock("../../utils/appDemo", () => ({ useDemoStatus: () => null, galleryProgress: () => null }));
vi.mock("../../utils/cloudFreshCheck", () => ({ fetchWebIsAhead: vi.fn(async () => false) }));
vi.mock("../../utils/v9CloudApi", () => ({ fetchLastMerge: vi.fn(async () => null), pullAfterAccept: vi.fn() }));
vi.mock("../../utils/cloudPublishApi", async (orig) => ({
  ...(await orig<typeof import("../../utils/cloudPublishApi")>()),
  fetchCloudCompatibility: vi.fn(async () => null),
  fetchCloudPublishReadiness: vi.fn(async () => ({ ok: true, errors: [], dependencies: { apps: [], databases: [] } })),
}));
vi.mock("../../components/Apps/ShareSheetBody", () => ({
  ShareSheetBody: () => <div data-testid="share-sheet-body">share sheet</div>,
}));
vi.mock("../../components/Apps/PublishInfoSheet", () => ({
  PublishInfoSheet: ({ onConfirmed }: { onConfirmed: () => void }) => (
    <button type="button" onClick={onConfirmed}>Confirm app info</button>
  ),
}));
vi.mock("../../components/common/PaprCloudRequirementsPanel", () => ({ PaprCloudRequirementsPanel: () => null }));

const failingJob = vi.hoisted(() => ({ current: null as null | { id: string; name: string } }));
vi.mock("../../stores/jobsStore", async (orig) => ({
  ...(await orig<typeof import("../../stores/jobsStore")>()),
  useAppFailingJob: () => failingJob.current,
}));

import { MiniAppPublishBar } from "../../components/Apps/MiniAppPublishBar";

function makeCloud(live: boolean) {
  return {
    live, busy: false, loading: false, refreshing: false, toast: null, errorDetail: null,
    statusLabel: live ? "Only you" : "Not published", compatibility: null,
    loginAccess: "private", externalLink: "off", codeAccess: "off", uploadMode: "manual",
    shareUrl: live ? "https://apps.papr.ai/x/demo" : null, publishedWebUrl: live ? "https://apps.papr.ai/x/demo" : null,
    publishedPreviewUrl: null, externalLinkUrl: null, loginUrl: null,
    sharePrefs: {}, shareModel: { audience: "private", permission: "read" },
    refresh: vi.fn(async () => {}), updateSharing: vi.fn(async () => {}), publish: vi.fn(async () => {}),
    unpublish: vi.fn(async () => {}), copyLink: vi.fn(), notifyLinkCopied: vi.fn(), notifyLinkCopyFailed: vi.fn(),
    openInBrowser: vi.fn(), setAutoUploadEnabled: vi.fn(), clearError: vi.fn(), reportError: vi.fn(),
  };
}

function renderBar(live: boolean, onRefreshPreview = vi.fn(), onOpenFailingJob?: (id: string) => void) {
  const cloud = makeCloud(live);
  const utils = render(
    <MiniAppPublishBar
      appId="app-1" appTitle="Demo" cloud={cloud as never}
      viewMode="local" onViewModeChange={vi.fn()}
      workspaceMode="preview" onWorkspaceModeChange={vi.fn()}
      workspacePanel={"none" as never} onWorkspacePanelChange={vi.fn()}
      onRefreshPreview={onRefreshPreview}
      onOpenFailingJob={onOpenFailingJob}
    />,
  );
  return { cloud, onRefreshPreview, ...utils };
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    papr: {
      listWorkspaceMembers: vi.fn(async () => ({ success: true, members: [] })),
      getActiveWorkspace: vi.fn(async () => ({ success: false })),
    },
  };
});

describe("MiniAppPublishBar — Job failing chip", () => {
  it("shows when a linked job failed and opens that job", () => {
    failingJob.current = { id: "job-9", name: "Search Scraper" };
    const open = vi.fn();
    renderBar(true, vi.fn(), open);
    fireEvent.click(screen.getByRole("button", { name: /Job failing/ }));
    expect(open).toHaveBeenCalledWith("job-9");
    failingJob.current = null;
  });

  it("is absent when no job failed", () => {
    failingJob.current = null;
    renderBar(true, vi.fn(), vi.fn());
    expect(screen.queryByRole("button", { name: /Job failing/ })).toBeNull();
  });
});

describe("MiniAppPublishBar — Share + Publish", () => {
  it("draft shows both Share and Publish", () => {
    renderBar(false);
    expect(screen.getByRole("button", { name: /^Share$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Publish/ })).toBeTruthy();
  });

  it("live shows Share and no URL row", () => {
    const { container } = renderBar(true);
    expect(screen.getByRole("button", { name: /^Share$/ })).toBeTruthy();
    expect(container.querySelector(".mini-app-publish-bar__url-row")).toBeNull();
    expect(screen.queryByText("https://apps.papr.ai/x/demo")).toBeNull();
  });

  it("Share on a live app opens the sheet directly, no publish", async () => {
    const { cloud } = renderBar(true);
    fireEvent.click(screen.getByRole("button", { name: /^Share$/ }));
    await screen.findByTestId("share-sheet-body");
    expect(cloud.publish).not.toHaveBeenCalled();
    expect(cloud.updateSharing).not.toHaveBeenCalled();
  });

  it("Share on a draft: App info first, then publishes, then opens the sheet", async () => {
    const { cloud } = renderBar(false);
    fireEvent.click(screen.getByRole("button", { name: /^Share$/ }));
    // First publish detours through App info; sheet not open yet, nothing published.
    const confirm = await screen.findByRole("button", { name: "Confirm app info" });
    expect(screen.queryByTestId("share-sheet-body")).toBeNull();
    expect(cloud.updateSharing).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(confirm); });
    await waitFor(() => expect(cloud.updateSharing).toHaveBeenCalled());
    await screen.findByTestId("share-sheet-body");
  });

  it("Share on a draft does not open the sheet when publishing fails", async () => {
    const { cloud } = renderBar(false);
    cloud.updateSharing.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(screen.getByRole("button", { name: /^Share$/ }));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Confirm app info" })); });
    await waitFor(() => expect(cloud.reportError).toHaveBeenCalled());
    expect(screen.queryByTestId("share-sheet-body")).toBeNull();
  });

  it("Refresh preview lives in the overflow menu", () => {
    const { onRefreshPreview } = renderBar(true);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Refresh preview/ }));
    expect(onRefreshPreview).toHaveBeenCalledTimes(1);
  });
});
