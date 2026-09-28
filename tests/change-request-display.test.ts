import { describe, expect, it } from "vitest";
import type { CloudChangeRequest } from "../ui/utils/cloudChangeRequestsApi";
import {
  listActionableIncomingChangeRequests,
  listUploadingIncomingChangeRequests,
  mergeOptimisticChangeRequestResolutions,
} from "../ui/utils/changeRequestDisplay";

function req(
  overrides: Partial<CloudChangeRequest> & Pick<CloudChangeRequest, "id">,
): CloudChangeRequest {
  return {
    sourceAppId: "app-1",
    installedAppId: "fork-1",
    title: "Test",
    description: "Desc",
    status: "pending",
    ...overrides,
  };
}

describe("changeRequestDisplay lists", () => {
  it("splits actionable vs still-uploading open requests", () => {
    const requests = [
      req({ id: "ready", headSha: "abcdef1234567890" }),
      req({ id: "uploading", status: "preparing" }),
      req({ id: "done", status: "approved" }),
    ];
    expect(listActionableIncomingChangeRequests(requests).map((r) => r.id)).toEqual([
      "ready",
    ]);
    expect(listUploadingIncomingChangeRequests(requests).map((r) => r.id)).toEqual([
      "uploading",
    ]);
  });

  it("applies optimistic resolution so accepted rows leave the actionable list", () => {
    const requests = [req({ id: "a", headSha: "abcdef1234567890" })];
    const merged = mergeOptimisticChangeRequestResolutions(
      requests,
      new Map([["a", "approved"]]),
    );
    expect(listActionableIncomingChangeRequests(merged)).toHaveLength(0);
  });
});
