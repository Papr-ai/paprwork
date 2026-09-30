import { describe, expect, it, vi } from "vitest";
import {
  readSourceAppIdFromApproveBody,
} from "../src/gateway/services/contributeApproveFollowUp.js";

describe("readSourceAppIdFromApproveBody", () => {
  it("reads camelCase sourceAppId", () => {
    expect(
      readSourceAppIdFromApproveBody({ sourceAppId: "  abc-123  " }),
    ).toBe("abc-123");
  });

  it("reads snake_case source_app_id", () => {
    expect(
      readSourceAppIdFromApproveBody({ source_app_id: "def-456" }),
    ).toBe("def-456");
  });

  it("returns undefined when missing", () => {
    expect(readSourceAppIdFromApproveBody({})).toBeUndefined();
  });
});

describe("contributor refresh after resolve", () => {
  it("reads installedAppId (camel and snake case)", async () => {
    const { readInstalledAppIdFromResolveBody } = await import(
      "../src/gateway/services/contributeApproveFollowUp.js"
    );
    expect(readInstalledAppIdFromResolveBody({ installedAppId: " a9 " })).toBe("a9");
    expect(readInstalledAppIdFromResolveBody({ installed_app_id: "b1" })).toBe("b1");
    expect(readInstalledAppIdFromResolveBody({})).toBeUndefined();
  });

  it("broadcasts items-stale for the contributor's installed app id", async () => {
    vi.resetModules();
    const broadcast = vi.fn();
    vi.doMock("../src/gateway/websocket/index.js", () => ({ broadcast }));
    const { notifyContributorProposalResolved } = await import(
      "../src/gateway/services/contributeApproveFollowUp.js"
    );
    notifyContributorProposalResolved("installed-123");
    notifyContributorProposalResolved(undefined);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({
      type: "cloud-sync:items-stale",
      data: { appId: "installed-123" },
    });
    vi.doUnmock("../src/gateway/websocket/index.js");
  });
});
