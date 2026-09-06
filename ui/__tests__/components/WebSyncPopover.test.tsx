/**
 * WebSyncPopover Component Tests
 *
 * Regression cover for the crash on clicking Upload before the first sync
 * check resolves:
 *   TypeError: Cannot read properties of null (reading 'hasSchemaDrift')
 *
 * `status` is typed `AppCloudSyncStatus | null`, and MiniAppPublishBar renders
 * the popover as soon as it opens — so null must render, never throw.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  WebSyncPopover,
  webSyncPushButtonLabel,
} from "../../components/Apps/WebSyncPopover";
import type { AppCloudSyncStatus } from "../../utils/appCloudSyncStatus";

const baseProps = {
  appId: "0a1ab32b-7c0c-4364-a98a-da637aa0dc70",
  onPushNow: vi.fn(),
  onBumpQueue: vi.fn(),
  onPullUpdates: vi.fn(),
  onApplyRemoteUpdates: vi.fn(),
};

function minimalSyncStatus(
  overrides: Partial<AppCloudSyncStatus> = {},
): AppCloudSyncStatus {
  return {
    overall: "changed",
    codePhase: "changed",
    codeStatus: "pending",
    codeLabel: "App code pending",
    dependentJobs: [],
    summaryLine: "local changes pending",
    databases: [],
    hasSchemaDrift: false,
    hasLinkedDatabases: false,
    hasRegistryDatabases: false,
    registryPhase: "synced",
    registryLabel: "Registry publishes with app code",
    chipLabel: "Pending",
    globallySyncing: false,
    cloudUploading: false,
    publishStatus: "synced",
    publishLabel: "Live",
    publishDetail: null,
    gitUpdatesAvailable: false,
    gitUpdatesSummary: null,
    writerConflict: false,
    gitRemoteRequiresReview: false,
    gitRemoteMetadataSync: false,
    gitRemoteReviewHeadline: null,
    syncedJobCount: 0,
    totalJobCount: 0,
    ...overrides,
  };
}

describe("WebSyncPopover", () => {
  it("renders without throwing when status is null and loading", () => {
    expect(() =>
      render(<WebSyncPopover {...baseProps} status={null} loading />),
    ).not.toThrow();

    expect(screen.getByText("Checking…")).toBeTruthy();
  });

  it("renders without throwing when status is null and NOT loading", () => {
    // The original crash path: popover opened before any status resolved,
    // with loading already false, so the `loading && !status` guard missed.
    expect(() =>
      render(<WebSyncPopover {...baseProps} status={null} loading={false} />),
    ).not.toThrow();
  });

  it("still offers Publish changes while status is unresolved (live app)", () => {
    render(
      <WebSyncPopover {...baseProps} status={null} loading={false} appLive />,
    );

    expect(screen.getByRole("button", { name: /upload now/i })).toBeTruthy();
  });

  it("offers Publish while status is unresolved (draft app)", () => {
    render(
      <WebSyncPopover {...baseProps} status={null} loading={false} appLive={false} />,
    );

    expect(screen.getByRole("button", { name: /^publish$/i })).toBeTruthy();
  });

  it("labels push action from publish state", () => {
    expect(webSyncPushButtonLabel({ appLive: false, pushing: false })).toBe("Publish");
    expect(webSyncPushButtonLabel({ appLive: false, pushing: true })).toBe("Publishing…");
    expect(webSyncPushButtonLabel({ appLive: true, pushing: false })).toBe("Publish changes");
    expect(webSyncPushButtonLabel({ appLive: true, pushing: true })).toBe("Publishing…");
  });

  it("surfaces an error alongside the unresolved state", () => {
    render(
      <WebSyncPopover
        {...baseProps}
        status={null}
        loading={false}
        error="App sync failed"
      />,
    );

    expect(screen.getByText("App sync failed")).toBeTruthy();
  });

  it("shows Ask agent when Publish changes fails with an error", () => {
    let openedMessage: string | undefined;
    const listener = (event: Event) => {
      openedMessage = (event as CustomEvent<{ message: string }>).detail.message;
    };
    window.addEventListener("papr-chat-open", listener);

    render(
      <WebSyncPopover
        {...baseProps}
        status={minimalSyncStatus()}
        syncActionNeeded
        error="sync engine operation failed: unable to checkpoint WAL"
      />,
    );

    expect(screen.getByRole("button", { name: /ask agent/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /ask agent/i }));
    expect(openedMessage).toContain("unable to checkpoint WAL");
    expect(openedMessage).toContain(baseProps.appId);

    window.removeEventListener("papr-chat-open", listener);
  });

  it("shows Ask agent for unresolved status when upload error is present", () => {
    render(
      <WebSyncPopover
        {...baseProps}
        status={null}
        loading={false}
        error="Turso push failed"
      />,
    );

    expect(screen.getByRole("button", { name: /ask agent/i })).toBeTruthy();
  });

  it("shows Ask agent when replica cutover is blocked (not only schemaDrift)", () => {
    let openedMessage: string | undefined;
    const listener = (event: Event) => {
      openedMessage = (event as CustomEvent<{ message: string }>).detail.message;
    };
    window.addEventListener("papr-chat-open", listener);

    render(
      <WebSyncPopover
        {...baseProps}
        status={minimalSyncStatus({
          hasSchemaDrift: false,
          databases: [
            {
              alias: "metrics",
              jobId: "job-1",
              status: "pending",
              phase: "changed",
              detail: "Cutover blocked: remote schema ahead",
              syncMode: "replica",
              cutoverBlocked: true,
              cutoverBlockReason: "remote schema ahead",
            },
          ],
        })}
        syncActionNeeded
      />,
    );

    expect(screen.getByRole("button", { name: /ask agent/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /ask agent/i }));
    expect(openedMessage).toContain("metrics");
    expect(openedMessage).toContain("cutover blocked");

    window.removeEventListener("papr-chat-open", listener);
  });

  it("shows Ask agent when large files are skipped from web sync", () => {
    let openedMessage: string | undefined;
    const listener = (event: Event) => {
      openedMessage = (event as CustomEvent<{ message: string }>).detail.message;
    };
    window.addEventListener("papr-chat-open", listener);

    render(
      <WebSyncPopover
        {...baseProps}
        status={minimalSyncStatus({
          overall: "synced",
          codePhase: "synced",
          codeStatus: "synced",
          codeLabel: "App code synced",
          summaryLine: "5 of 5 jobs on the web",
          oversizedAppFilesCount: 1,
          oversizedAppFilesMessage:
            "1 file(s) in this app will not sync to the web:\n  • apps/9e70c06b/data.db (never tracked by git — use App Files)",
        })}
      />,
    );

    expect(screen.getByRole("button", { name: /ask agent/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /ask agent/i }));
    expect(openedMessage).toContain("data.db");
    expect(openedMessage).toContain(baseProps.appId);

    window.removeEventListener("papr-chat-open", listener);
  });
});
