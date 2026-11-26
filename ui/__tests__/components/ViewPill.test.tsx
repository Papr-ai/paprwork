/**
 * Share bar v2 (plan step 7): status sorting into Live / Preview, dots, and the pill.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ViewPill } from "../../components/Apps/ViewPill";
import { defaultView, resolveViewPill, viewDot, type ViewPillModel } from "../../utils/viewPill";
import type { CopyBar } from "../../utils/copyState";

const chip = (label: string, tone: CopyBar["chip"]["tone"], action: CopyBar["chip"]["action"] = null, verb: string | null = null) =>
  ({ chip: { label, tone, action, verb } }) as unknown as CopyBar;
const owner = { label: "Live", tone: "ok" as const };
const base = { ownerChip: owner, ownerHasUnpublished: false, ownerLive: true, publisherSlug: "amir" };

describe("resolveViewPill", () => {
  it("sent change waiting: Live says it's without your change; a real Live status still wins", () => {
    const waiting = resolveViewPill({ ...base, copyBar: chip("Proposal sent", "idle", "view_proposal", "View") });
    expect(waiting.live.label).toBe("Change pending");
    const owner = resolveViewPill({ ...base, copyBar: null, ownerHasUnpublished: true });
    expect(owner.live).toMatchObject({ label: "Without edits", verb: "Publish", action: "go_preview" });
    expect(owner.live.hint).toContain("until you publish");
    const failing = resolveViewPill({ ...base, copyBar: null, ownerHasUnpublished: true, ownerChip: { label: "Last publish failed", tone: "bad" } });
    expect(failing.live).toMatchObject({ label: "Publish failed", tone: "warn" });
  });

  it("clean copy: Live up to date, Preview empty, opens in Live", () => {
    const m = resolveViewPill({ ...base, copyBar: chip("Same as the team's app", "ok") });
    expect(m.live).toMatchObject({ label: "Up to date", tone: "ok" });
    expect(m.preview.empty).toBe(true);
    expect(m.preview.label).toBe("Same as Live");
    expect(defaultView(m)).toBe("live");
  });

  it("unproposed edits belong to Preview and open it", () => {
    const m = resolveViewPill({ ...base, copyBar: chip("Edits not proposed", "warn", "propose", "Propose") });
    expect(m.preview).toMatchObject({ label: "Not proposed yet", tone: "warn", verb: "Propose" });
    // Live is in sync with the web but doesn't have your edits: not "Up to date".
    expect(m.live).toMatchObject({ label: "Without edits", tone: "idle", verb: "Propose", action: "go_preview" });
    expect(m.live.hint).toContain("only in Preview");
    expect(viewDot("live", m.live)).toBeNull();
    expect(defaultView(m)).toBe("preview");
  });

  it("waiting names the reviewer; declined is red with See why", () => {
    expect(resolveViewPill({ ...base, copyBar: chip("Proposal sent", "idle", "view_proposal", "View") }).preview.label)
      .toBe("Waiting for review");
    expect(resolveViewPill({ ...base, copyBar: chip("Proposal declined", "bad", "see_decline", "See why") }).preview)
      .toMatchObject({ tone: "warn", verb: "See why" });
  });

  it("teammate updates and conflicts are Live's status", () => {
    const m = resolveViewPill({ ...base, copyBar: chip("Publisher has updates", "info", "get_updates", "Get updates") });
    expect(m.live).toMatchObject({ label: "Update ready", tone: "warn", verb: "Get updates" });
    expect(m.preview.empty).toBe(true);
    expect(resolveViewPill({ ...base, copyBar: chip("Update conflicts", "bad", "review_conflicts", "Review") }).live)
      .toMatchObject({ label: "Conflicts", tone: "warn" });
  });

  it("owner with unpublished edits: Preview says so; a failed publish stays on Live", () => {
    const m = resolveViewPill({ ...base, copyBar: null, ownerHasUnpublished: true,
      ownerChip: { label: "Last publish failed", tone: "bad" } });
    expect(m.preview).toMatchObject({ label: "Not published yet", verb: "Publish" });
    expect(m.live).toMatchObject({ label: "Publish failed", tone: "warn" });
  });

  it("labels are short; accepted, local-only and in-progress states", () => {
    expect(resolveViewPill({ ...base, copyBar: chip("Proposal accepted", "ok", "view_proposal", "View") }))
      .toMatchObject({ live: { label: "Change accepted", tone: "ok" }, preview: { empty: true } });
    expect(resolveViewPill({ ...base, copyBar: null, ownerLive: false }).live).toMatchObject({ label: "Local only", tone: "idle" });
    expect(resolveViewPill({ ...base, copyBar: null, ownerChip: { label: "Publishing…", tone: "busy" } }).live)
      .toMatchObject({ label: "Publishing…", tone: "idle" });
    expect(resolveViewPill({ ...base, copyBar: null, ownerChip: { label: "Live · last checked 3h ago", tone: "ok" } }).live.label)
      .toBe("Up to date");
    for (const l of ["Update ready", "Conflicts", "Publish failed", "Without edits", "Change pending", "Change accepted", "Local only"])
      expect(l.split(" ").length).toBeLessThanOrEqual(2);
  });

  it("a failing job puts a red dot on Settings that leads to Jobs", () => {
    const m = resolveViewPill({ ...base, copyBar: null, failingJobName: "Nightly sync" });
    expect(m.settingsDot).toEqual({ tone: "bad", target: "jobs", label: "Nightly sync failed" });
  });
});

describe("viewDot", () => {
  it("only when the other view needs a look", () => {
    expect(viewDot("live", { label: "Up to date", tone: "ok" })).toBeNull();
    expect(viewDot("live", { label: "Offline", tone: "warn" })).toBe("warn");
    expect(viewDot("preview", { label: "Same as Live", tone: "idle", empty: true })).toBeNull();
    expect(viewDot("preview", { label: "Waiting for review", tone: "idle" })).toBeNull();
    expect(viewDot("preview", { label: "Declined", tone: "warn" })).toBe("warn");
  });
});

describe("ViewPill", () => {
  const model: ViewPillModel = {
    live: { label: "Up to date", tone: "ok" },
    preview: { label: "Not proposed yet", tone: "warn", verb: "Propose", action: "propose" },
    settingsDot: { tone: "bad", target: "jobs", label: "Nightly sync failed" },
  };

  it("open view shows its status; the other a dot; Settings a dot that opens Jobs", () => {
    const onView = vi.fn();
    const onSettings = vi.fn();
    render(<ViewPill model={model} active="live" settingsOpen={false} onView={onView} onVerb={vi.fn()} onSettings={onSettings} />);
    expect(screen.getByText("Up to date")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview, Not proposed yet" }));
    expect(onView).toHaveBeenCalledWith("preview");
    fireEvent.click(screen.getByRole("button", { name: "Settings, Nightly sync failed" }));
    expect(onSettings).toHaveBeenCalledWith("jobs");
  });

  it("the verb on the open view runs its action", () => {
    const onVerb = vi.fn();
    render(<ViewPill model={model} active="preview" settingsOpen={false} onView={vi.fn()} onVerb={onVerb} onSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Propose" }));
    expect(onVerb).toHaveBeenCalledWith("preview", model.preview);
  });
});

describe("ViewPill preview switcher (8d)", () => {
  const model: ViewPillModel = {
    live: { label: "Up to date", tone: "ok" },
    preview: { label: "Priority", tone: "ok" },
    settingsDot: null,
  };
  it("lists your changes and each proposal; one pick at a time", () => {
    const onPick = vi.fn();
    render(<ViewPill model={model} active="preview" settingsOpen={false} onView={vi.fn()} onVerb={vi.fn()} onSettings={vi.fn()}
      previews={[{ id: null, label: "Your changes" }, { id: "r1", label: "Priority" }, { id: "r2", label: "Due dates" }]}
      activePreview="r1" onPickPreview={onPick} />);
    fireEvent.click(screen.getByTitle("Switch preview"));
    expect(screen.getByRole("menuitemradio", { name: /Priority/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Due dates/ }));
    expect(onPick).toHaveBeenCalledWith("r2");
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("no menu with only your own changes", () => {
    render(<ViewPill model={model} active="preview" settingsOpen={false} onView={vi.fn()} onVerb={vi.fn()} onSettings={vi.fn()}
      previews={[{ id: null, label: "Your changes" }]} onPickPreview={vi.fn()} />);
    expect(screen.queryByTitle("Switch preview")).toBeNull();
  });
});
