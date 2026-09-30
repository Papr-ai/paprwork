/**
 * The behaviour this component exists for: say almost nothing until asked.
 *
 * Each test below is one of the complaints about the banner it replaces — the
 * provider's paragraph on screen unprompted, a Resume button with no stated
 * reason to press it, and no way to make any of it go away.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProviderErrorChip } from "../components/Chat/ProviderErrorChip";
import { describeProviderNotice } from "../utils/providerErrorPresentation";

const ensureSettingsTab = vi.hoisted(() => vi.fn());
vi.mock("../lib/ensureSettingsTab", () => ({ ensureSettingsTab }));

const rateLimit = () =>
  describeProviderNotice({
    message: "Rate limit exceeded (429): retry after 12s",
    provider: "openai",
    canResume: true,
  });

const usageLimit = () =>
  describeProviderNotice({
    message: "Claude usage limit reached. Your limit resets at 3:00 PM.",
    provider: "anthropic",
  });

describe("ProviderErrorChip", () => {
  it("shows a headline and hides the provider's paragraph until asked", () => {
    render(<ProviderErrorChip notice={rateLimit()} />);

    expect(screen.getByText("Too many requests")).toBeTruthy();
    // The verbatim text — the part that used to fill a red band — starts out
    // absent from the document, not merely visually quiet.
    expect(screen.queryByText(/retry after 12s/)).toBeNull();
    expect(screen.queryByTestId("provider-notice-panel")).toBeNull();
  });

  it("opens one sentence and one button on click", () => {
    render(<ProviderErrorChip notice={rateLimit()} />);
    fireEvent.click(screen.getByTestId("provider-notice-chip"));

    expect(screen.getByTestId("provider-notice-panel")).toBeTruthy();
    expect(
      screen.getByText(/limiting how fast requests come in/),
    ).toBeTruthy();
    // One action, never a menu of them.
    expect(screen.getAllByTestId("provider-notice-action")).toHaveLength(1);
  });

  it("reveals the raw provider text only behind Details", () => {
    render(<ProviderErrorChip notice={rateLimit()} />);
    fireEvent.click(screen.getByTestId("provider-notice-chip"));
    expect(screen.queryByText(/retry after 12s/)).toBeNull();

    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText(/retry after 12s/)).toBeTruthy();

    fireEvent.click(screen.getByText("Hide details"));
    expect(screen.queryByText(/retry after 12s/)).toBeNull();
  });

  it("resumes through the chat's own handler and closes itself", () => {
    const onResume = vi.fn();
    render(<ProviderErrorChip notice={rateLimit()} onResume={onResume} />);

    fireEvent.click(screen.getByTestId("provider-notice-chip"));
    fireEvent.click(screen.getByTestId("provider-notice-action"));

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("provider-notice-panel")).toBeNull();
  });

  it("disables its button while a resume is already running", () => {
    render(<ProviderErrorChip notice={rateLimit()} isResuming onResume={vi.fn()} />);
    fireEvent.click(screen.getByTestId("provider-notice-chip"));

    const action = screen.getByTestId("provider-notice-action");
    expect(action.textContent).toBe("Resuming…");
    expect((action as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends an account problem to the right Settings page", () => {
    ensureSettingsTab.mockClear();
    render(<ProviderErrorChip notice={usageLimit()} />);

    fireEvent.click(screen.getByTestId("provider-notice-chip"));
    fireEvent.click(screen.getByTestId("provider-notice-action"));

    expect(ensureSettingsTab).toHaveBeenCalledWith({ section: "models" });
  });

  it("can be dismissed, and closes on Escape", () => {
    const onDismiss = vi.fn();
    render(<ProviderErrorChip notice={usageLimit()} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTestId("provider-notice-chip"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("provider-notice-panel")).toBeNull();

    fireEvent.click(screen.getByTestId("provider-notice-chip"));
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("carries the full sentence to screen readers while staying short on screen", () => {
    render(<ProviderErrorChip notice={usageLimit()} />);
    const chip = screen.getByTestId("provider-notice-chip");

    expect(chip.textContent).toBe("Usage limit reached");
    expect(chip.getAttribute("aria-label")).toContain("resets at 3:00 PM");
  });

  it("offers no button when there is nothing to press", () => {
    const notice = describeProviderNotice({
      message: "prompt is too long: maximum context exceeded",
    });
    render(<ProviderErrorChip notice={notice} />);
    fireEvent.click(screen.getByTestId("provider-notice-chip"));

    expect(screen.queryByTestId("provider-notice-action")).toBeNull();
    expect(screen.getByText(/Start a new chat/)).toBeTruthy();
  });
});
