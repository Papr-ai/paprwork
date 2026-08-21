import { afterEach, describe, expect, test, vi } from "vitest";

describe("appRepoCommittedFanout", () => {
  afterEach(async () => {
    const { clearAppRepoCommitCursorsForTests } = await import(
      "../src/gateway/services/syncV3/appRepoCommittedFanout.js"
    );
    await clearAppRepoCommitCursorsForTests();
  });

  test("dedupes identical appId+commitSha events", async () => {
    const { fanoutAppRepoCommitted, subscribeAppRepoCommitted } = await import(
      "../src/gateway/services/syncV3/appRepoCommittedFanout.js"
    );

    let callCount = 0;
    subscribeAppRepoCommitted(() => {
      callCount += 1;
    });

    const event = {
      appId: "app-1",
      commitSha: "abc123",
      githubOrg: "papr-shard-0001",
      repoName: "app-app-1",
      namespaceId: "ns-1",
      committedAt: new Date().toISOString(),
    };

    await fanoutAppRepoCommitted(event);
    await fanoutAppRepoCommitted(event);

    expect(callCount).toBe(1);
  });

  test("cursor store persists last commit sha", async () => {
    const {
      writeAppRepoCommitCursor,
      readAppRepoCommitCursors,
    } = await import("../src/gateway/services/syncV3/appRepoCommittedFanout.js");

    await writeAppRepoCommitCursor("app-1", "deadbeef");
    const cursors = await readAppRepoCommitCursors();
    expect(cursors["app-1"]?.lastCommitSha).toBe("deadbeef");
  });

  test("posts webhook with X-Cloud-App-Host-Key when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const prevWebhook = process.env.PAPR_APP_REPO_COMMITTED_WEBHOOK_URL;
    const prevKey = process.env.PAPR_CLOUD_APP_HOST_KEY;
    process.env.PAPR_APP_REPO_COMMITTED_WEBHOOK_URL =
      "https://apps.example/internal/app-repo-committed";
    process.env.PAPR_CLOUD_APP_HOST_KEY = "test-host-key";

    try {
      const { fanoutAppRepoCommitted } = await import(
        "../src/gateway/services/syncV3/appRepoCommittedFanout.js"
      );

      const event = {
        appId: "app-webhook",
        commitSha: "feedface",
        githubOrg: "papr-shard-0001",
        repoName: "app-app-webhook",
        namespaceId: "ns-1",
        committedAt: new Date().toISOString(),
      };

      await fanoutAppRepoCommitted(event);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://apps.example/internal/app-repo-committed",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Cloud-App-Host-Key": "test-host-key",
          },
          body: JSON.stringify(event),
        }),
      );
    } finally {
      if (prevWebhook === undefined) {
        delete process.env.PAPR_APP_REPO_COMMITTED_WEBHOOK_URL;
      } else {
        process.env.PAPR_APP_REPO_COMMITTED_WEBHOOK_URL = prevWebhook;
      }
      if (prevKey === undefined) {
        delete process.env.PAPR_CLOUD_APP_HOST_KEY;
      } else {
        process.env.PAPR_CLOUD_APP_HOST_KEY = prevKey;
      }
      vi.unstubAllGlobals();
    }
  });

  test("parses direct and Pub/Sub push payloads", async () => {
    const {
      isAppRepoCommittedEvent,
      parseAppRepoCommittedPayload,
    } = await import("../src/gateway/services/syncV3/appRepoCommittedInbound.js");

    const event = {
      appId: "app-1",
      commitSha: "abc123",
      githubOrg: "papr-shard-0001",
      repoName: "app-app-1",
      namespaceId: "ns-1",
      committedAt: new Date().toISOString(),
    };

    expect(isAppRepoCommittedEvent(event)).toBe(true);
    expect(parseAppRepoCommittedPayload(event)).toEqual(event);

    const encoded = Buffer.from(JSON.stringify(event), "utf8").toString("base64");
    expect(
      parseAppRepoCommittedPayload({
        message: { data: encoded },
      }),
    ).toEqual(event);
  });
});
