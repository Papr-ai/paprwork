import { describe, expect, it } from "vitest";
import {
  isProposalExcludedAppPath,
  stripProposalExcludedAppFiles,
} from "../src/gateway/services/cloudSync/contributeProposalPaths.js";
import {
  changeRequestNeedsUpdate,
  changeRequestStatusLabel,
  isResolvedChangeRequest,
  listActionableIncomingChangeRequests,
} from "../ui/utils/changeRequestDisplay.js";
import {
  collaboratorProposalStatusFromSent,
  resolveCollaboratorBar,
} from "../ui/utils/appCloudSyncStatus.js";
import type { CloudChangeRequest } from "../ui/utils/cloudChangeRequestsApi.js";

describe("proposal paths", () => {
  it("leaves out build outputs and per-copy metadata", () => {
    for (const rel of [
      "metadata.json",
      "backend/bundle.json",
      "__papr__/app-meta.json",
      "__papr__/platform-catalog.json",
      "dist/app.js",
    ]) {
      expect(isProposalExcludedAppPath(rel)).toBe(true);
    }
  });
  it("keeps real source, including backend handlers", () => {
    for (const rel of ["index.html", "db.ts", "base.css", "backend/ping.py", "backend/manifest.json", "README.md"]) {
      expect(isProposalExcludedAppPath(rel)).toBe(false);
    }
  });
  it("strips in place and reports what it removed", () => {
    const files = new Map([
      ["index.html", "<h1>v1 + edit B</h1>"],
      ["metadata.json", "{}"],
      ["backend/bundle.json", "{}"],
      ["__papr__/app-meta.json", "{}"],
    ]);
    expect(stripProposalExcludedAppFiles(files)).toEqual([
      "__papr__/app-meta.json",
      "backend/bundle.json",
      "metadata.json",
    ]);
    expect([...files.keys()]).toEqual(["index.html"]);
  });
});

const req = (over: Partial<CloudChangeRequest>): CloudChangeRequest => ({
  id: "r",
  sourceAppId: "a",
  installedAppId: "c",
  title: "t",
  description: "d",
  status: "pending",
  headSha: "abcdef1234",
  ...over,
});

describe("owner: stale proposals", () => {
  it("pending + conflict needs update; clean/unknown does not", () => {
    expect(changeRequestNeedsUpdate(req({ mergeState: "conflict" }))).toBe(true);
    expect(changeRequestNeedsUpdate(req({ mergeState: "clean" }))).toBe(false);
    expect(changeRequestNeedsUpdate(req({ mergeState: "unknown" }))).toBe(false);
    expect(changeRequestNeedsUpdate(req({ status: "approved", mergeState: "conflict" }))).toBe(false);
  });
  it("superseded proposals move to history", () => {
    const old = req({ status: "superseded", supersededBy: "r2" });
    expect(isResolvedChangeRequest(old)).toBe(true);
    expect(changeRequestStatusLabel(old)).toBe("Replaced by a newer proposal");
    expect(listActionableIncomingChangeRequests([old])).toEqual([]);
  });
});

describe("contributor: needs update", () => {
  it("maps the newest sent proposal", () => {
    expect(collaboratorProposalStatusFromSent({ status: "pending", mergeState: "conflict" })).toBe("needs_update");
    expect(collaboratorProposalStatusFromSent({ status: "pending", mergeState: "clean" })).toBe("pending");
    expect(collaboratorProposalStatusFromSent({ status: "superseded" })).toBeNull();
    expect(collaboratorProposalStatusFromSent(undefined)).toBeNull();
  });
  it("chip says Needs update with a one-click Update & re-propose, even when the publisher is ahead", () => {
    const bar = resolveCollaboratorBar({
      hasLocalEdits: true,
      hasUnproposedEdits: false,
      latestProposalStatus: "needs_update",
      publisherAhead: true,
      pullingUpstream: false,
      busy: false,
      sourceSlug: "demo",
    });
    expect(bar.chip.label).toBe("Needs update");
    expect(bar.chipAction).toEqual({ kind: "upstream", glyph: "down", verb: "Update & re-propose" });
  });
});
