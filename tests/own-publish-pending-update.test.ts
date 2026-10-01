import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gateway/websocket/index.js", () => ({ broadcast: vi.fn() }));

const pullMock = vi.fn();
vi.mock("../src/gateway/services/syncV3/pullAppCodeFromRepo.js", () => ({
  pullDesktopAppOnRemoteCommit: (...args: unknown[]) => pullMock(...args),
}));
vi.mock("../src/gateway/services/syncV3/appRepoCommittedFanout.js", () => ({
  readAppRepoCommitCursors: vi.fn(async () => ({})),
  subscribeAppRepoCommitted: vi.fn(() => () => {}),
  writeAppRepoCommitCursor: vi.fn(async () => {}),
}));

import {
  getPendingAppUpdate,
  markPendingAppUpdate,
  rememberOwnAppCommit,
  resetPendingAppUpdatesForTests,
} from "../src/gateway/services/syncV3/appRepoPendingUpdate.js";
import { applyRemoteCommit } from "../src/gateway/services/syncV3/appRepoRevisionSubscriber.js";

describe("own publish is never shown as a newer version on web", () => {
  beforeEach(() => {
    resetPendingAppUpdatesForTests();
    pullMock.mockReset();
  });

  it("commit event after the ack: recognised as ours, no pull, nothing pending", async () => {
    rememberOwnAppCommit("app-1", "sha-own");
    expect(await applyRemoteCommit("app-1", "sha-own")).toBe(true);
    expect(pullMock).not.toHaveBeenCalled();
    expect(getPendingAppUpdate("app-1")).toBeNull();
  });

  it("commit event before the ack (parked as waiting): the ack clears it", () => {
    markPendingAppUpdate(
      { appId: "app-1", commitSha: "sha-own", reason: "local changes pending upload" },
      async () => false,
    );
    expect(getPendingAppUpdate("app-1")).not.toBeNull();
    rememberOwnAppCommit("app-1", "sha-own");
    expect(getPendingAppUpdate("app-1")).toBeNull();
  });

  it("ack lands while the pull is deciding: not parked", async () => {
    pullMock.mockImplementation(async () => {
      rememberOwnAppCommit("app-1", "sha-own");
      return { pulled: false, waitingReason: "local changes pending upload" };
    });
    expect(await applyRemoteCommit("app-1", "sha-own")).toBe(true);
    expect(getPendingAppUpdate("app-1")).toBeNull();
  });

  it("someone else's commit still parks as a waiting update", async () => {
    rememberOwnAppCommit("app-1", "sha-own");
    pullMock.mockResolvedValue({ pulled: false, waitingReason: "local changes pending upload" });
    expect(await applyRemoteCommit("app-1", "sha-other")).toBe(false);
    expect(getPendingAppUpdate("app-1")?.commitSha).toBe("sha-other");
  });

  it("an ack for a different commit does not clear a real waiting update", () => {
    markPendingAppUpdate(
      { appId: "app-1", commitSha: "sha-other", reason: "local changes pending upload" },
      async () => false,
    );
    rememberOwnAppCommit("app-1", "sha-own");
    expect(getPendingAppUpdate("app-1")?.commitSha).toBe("sha-other");
  });
});
