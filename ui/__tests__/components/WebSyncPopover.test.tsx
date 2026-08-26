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
import { render, screen } from "@testing-library/react";
import { WebSyncPopover } from "../../components/Apps/WebSyncPopover";

const baseProps = {
  appId: "0a1ab32b-7c0c-4364-a98a-da637aa0dc70",
  onPushNow: vi.fn(),
  onBumpQueue: vi.fn(),
  onPullUpdates: vi.fn(),
  onApplyRemoteUpdates: vi.fn(),
};

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

  it("still offers Upload now while status is unresolved", () => {
    render(<WebSyncPopover {...baseProps} status={null} loading={false} />);

    // Previously returned null here, so clicking Upload showed nothing at all.
    expect(screen.getByRole("button", { name: /upload now/i })).toBeTruthy();
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
});
