import { describe, expect, it } from "vitest";
import {
  buildChangeRequestSummaryParts,
  isChangeRequestReadyForReview,
  listResolvedChangeRequests,
} from "../ui/utils/changeRequestDisplay";
import { isIncomingChangeRequestOpen } from "../ui/hooks/useIncomingCloudChangeRequests";
import { buildPrReviewAgentPrompt } from "../ui/utils/openCloudSyncAgentChat";

describe("changeRequestDisplay", () => {
  it("treats pending requests with headSha as ready without showing PR", () => {
    const req = {
      id: "1",
      sourceAppId: "app",
      installedAppId: "fork",
      title: "T",
      description: "Analysis changes",
      status: "pending",
      headSha: "abc1234567890",
      branch: "contrib/line/abc",
    };
    expect(isChangeRequestReadyForReview(req)).toBe(true);
    const parts = buildChangeRequestSummaryParts(req);
    expect(parts.narrative).toBe("Analysis changes");
    expect(parts.commitRef).toBe("abc1234");
    expect(parts.branch).toBe("contrib/line/abc");
  });

  it("sorts resolved proposals by resolvedAt descending", () => {
    const sorted = listResolvedChangeRequests([
      {
        id: "old",
        status: "approved",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      } as never,
      {
        id: "new",
        status: "rejected",
        resolvedAt: "2026-06-01T00:00:00.000Z",
      } as never,
      { id: "open", status: "pending" } as never,
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("counts preparing proposals as open for the inbox", () => {
    expect(
      isIncomingChangeRequestOpen({ id: "1", status: "preparing" } as never),
    ).toBe(true);
    expect(
      isIncomingChangeRequestOpen({ id: "1", status: "approved" } as never),
    ).toBe(false);
  });

  it("agent prompt avoids relying on a GitHub PR URL", () => {
    const prompt = buildPrReviewAgentPrompt({
      sourceAppId: "app-1",
      title: "Updates",
      description: "Analysis changes",
      requestId: "req-1",
      headSha: "deadbeef",
      stagedPaths: ["apps/foo/index.html"],
    });
    expect(prompt).toContain("get_cloud_app_pr_review");
    expect(prompt).not.toContain("http");
    expect(prompt).toContain("apps/foo/index.html");
  });
});
