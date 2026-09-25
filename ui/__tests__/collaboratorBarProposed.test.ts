import { describe, expect, it } from "vitest";
import {
  collaboratorChipOpensProposeSheet,
  resolveCollaboratorBar,
} from "../utils/appCloudSyncStatus";

const base = { publisherAhead: false, pullingUpstream: false, busy: false, sourceSlug: "demo" };

describe("resolveCollaboratorBar after a proposal", () => {
  it("edits already proposed: Proposal sent, no Propose action", () => {
    const r = resolveCollaboratorBar({ ...base, hasLocalEdits: true, hasUnproposedEdits: false });
    expect(r.chip.label).toBe("Proposal sent");
    expect(r.chipAction).toBeNull();
    expect(r.primary.disabled).toBe(true);
  });
  it("new edits after proposing: Edits not proposed again", () => {
    const r = resolveCollaboratorBar({ ...base, hasLocalEdits: true, hasUnproposedEdits: true });
    expect(r.chip.label).toBe("Edits not proposed");
    expect(r.primary.disabled).toBe(false);
  });
  it("older callers without hasUnproposedEdits keep the old behaviour", () => {
    const r = resolveCollaboratorBar({ ...base, hasLocalEdits: true });
    expect(r.chip.label).toBe("Edits not proposed");
  });

  it("Proposal sent chip opens propose sheet, not owner publish", () => {
    expect(collaboratorChipOpensProposeSheet("Proposal sent")).toBe(true);
    expect(collaboratorChipOpensProposeSheet("Edits not proposed")).toBe(false);
    expect(collaboratorChipOpensProposeSheet("In sync with publisher")).toBe(false);
  });

  it("shows owner decision on the chip when proposal status is known", () => {
    const pending = resolveCollaboratorBar({
      ...base,
      hasLocalEdits: true,
      hasUnproposedEdits: false,
      latestProposalStatus: "pending",
    });
    expect(pending.chip.label).toBe("Waiting for review");
    expect(pending.openProposeSheetOnChipClick).toBe(true);

    const approved = resolveCollaboratorBar({
      ...base,
      hasLocalEdits: true,
      hasUnproposedEdits: false,
      latestProposalStatus: "approved",
      publisherAhead: true,
    });
    expect(approved.chip.label).toBe("Accepted — pull updates");
    expect(approved.chipAction?.kind).toBe("upstream");

    const rejected = resolveCollaboratorBar({
      ...base,
      hasLocalEdits: true,
      hasUnproposedEdits: false,
      latestProposalStatus: "rejected",
    });
    expect(rejected.chip.label).toBe("Declined — propose again");
    expect(rejected.primary.disabled).toBe(true);

    const rejectedWithNewEdits = resolveCollaboratorBar({
      ...base,
      hasLocalEdits: true,
      hasUnproposedEdits: true,
      latestProposalStatus: "rejected",
    });
    expect(rejectedWithNewEdits.chip.label).toBe("Edits not proposed");
    expect(rejectedWithNewEdits.primary.disabled).toBe(false);
  });
});
