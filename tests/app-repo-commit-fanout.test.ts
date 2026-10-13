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

  describe("gateway webhook Google identity token", () => {
    const ENV = ["PAPR_APP_REPO_COMMITTED_GATEWAY_WEBHOOK_URL", "PAPR_CLOUD_AGENT_GATEWAY_KEY", "K_SERVICE"] as const;
    const saved: Record<string, string | undefined> = {};
    const event = {
      appId: "app-gateway-iam",
      commitSha: "f00dfeed",
      githubOrg: "papr-shard-0001",
      repoName: "app-app-gateway-iam",
      namespaceId: "ns-1",
      committedAt: "2026-01-01T00:00:00.000Z",
    };
    const isMetadata = (u: string) => u.startsWith("http://metadata.google.internal/");

    beforeEach(async () => {
      for (const k of ENV) saved[k] = process.env[k];
      process.env.PAPR_APP_REPO_COMMITTED_GATEWAY_WEBHOOK_URL = "https://gateway-iam.example/internal/app-repo-committed";
      process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY = "test-gateway-key";
      const m = await import("../src/gateway/services/syncV3/appRepoCommittedFanout.js");
      m.clearIdentityTokenCacheForTests();
    });
    afterEach(() => {
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      vi.unstubAllGlobals();
    });

    async function fan(id: string) {
      const { fanoutAppRepoCommitted } = await import("../src/gateway/services/syncV3/appRepoCommittedFanout.js");
      await fanoutAppRepoCommitted({ ...event, commitSha: id });
    }
    const gatewayCalls = (f: ReturnType<typeof vi.fn>) =>
      f.mock.calls.filter((c) => String(c[0]).startsWith("https://gateway-iam.example"));

    test("on Cloud Run sends Bearer id token (audience = gateway origin) plus the gateway key", async () => {
      process.env.K_SERVICE = "app-repo-writer";
      const f = vi.fn(async (u: string) => (isMetadata(u) ? { ok: true, text: async () => "id-token-xyz\n" } : { ok: true }));
      vi.stubGlobal("fetch", f);
      await fan("c1");
      const meta = f.mock.calls.find((c) => isMetadata(String(c[0])))!;
      expect(String(meta[0])).toContain("audience=" + encodeURIComponent("https://gateway-iam.example"));
      expect(meta[1]).toMatchObject({ headers: { "Metadata-Flavor": "Google" } });
      const [gw] = gatewayCalls(f);
      expect(gw[1].headers).toEqual({
        "Content-Type": "application/json",
        "X-Cloud-Agent-Gateway-Key": "test-gateway-key",
        Authorization: "Bearer id-token-xyz",
      });
    });

    test("off Cloud Run (no K_SERVICE) never calls the metadata server and sends no Authorization", async () => {
      delete process.env.K_SERVICE;
      const f = vi.fn(async () => ({ ok: true }));
      vi.stubGlobal("fetch", f);
      await fan("c2");
      expect(f.mock.calls.some((c) => isMetadata(String(c[0])))).toBe(false);
      expect(gatewayCalls(f)[0][1].headers.Authorization).toBeUndefined();
    });

    test("token is cached: two commits cost one metadata fetch", async () => {
      process.env.K_SERVICE = "app-repo-writer";
      const f = vi.fn(async (u: string) => (isMetadata(u) ? { ok: true, text: async () => "tok" } : { ok: true }));
      vi.stubGlobal("fetch", f);
      await fan("c3");
      await fan("c4");
      expect(f.mock.calls.filter((c) => isMetadata(String(c[0]))).length).toBe(1);
      expect(gatewayCalls(f).length).toBe(2);
    });

    test("metadata failure still posts the webhook (key only) instead of dropping the event", async () => {
      process.env.K_SERVICE = "app-repo-writer";
      const f = vi.fn(async (u: string) => {
        if (isMetadata(u)) throw new Error("metadata down");
        return { ok: true };
      });
      vi.stubGlobal("fetch", f);
      await fan("c5");
      const [gw] = gatewayCalls(f);
      expect(gw[1].headers["X-Cloud-Agent-Gateway-Key"]).toBe("test-gateway-key");
      expect(gw[1].headers.Authorization).toBeUndefined();
    });
  });

  test("posts gateway webhook with X-Cloud-Agent-Gateway-Key when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const prevWebhook = process.env.PAPR_APP_REPO_COMMITTED_GATEWAY_WEBHOOK_URL;
    const prevKey = process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY;
    process.env.PAPR_APP_REPO_COMMITTED_GATEWAY_WEBHOOK_URL =
      "https://gateway.example/internal/app-repo-committed";
    process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY = "test-gateway-key";

    try {
      const { fanoutAppRepoCommitted } = await import(
        "../src/gateway/services/syncV3/appRepoCommittedFanout.js"
      );

      const event = {
        appId: "app-gateway",
        commitSha: "cafebabe",
        githubOrg: "papr-shard-0001",
        repoName: "app-app-gateway",
        namespaceId: "ns-1",
        committedAt: new Date().toISOString(),
      };

      await fanoutAppRepoCommitted(event);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://gateway.example/internal/app-repo-committed",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Cloud-Agent-Gateway-Key": "test-gateway-key",
          },
          body: JSON.stringify(event),
        }),
      );
    } finally {
      if (prevWebhook === undefined) {
        delete process.env.PAPR_APP_REPO_COMMITTED_GATEWAY_WEBHOOK_URL;
      } else {
        process.env.PAPR_APP_REPO_COMMITTED_GATEWAY_WEBHOOK_URL = prevWebhook;
      }
      if (prevKey === undefined) {
        delete process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY;
      } else {
        process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY = prevKey;
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
