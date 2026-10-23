import { beforeEach, describe, expect, it, vi } from "vitest";

const webReady = vi.fn();
const fetchAppRepoHead = vi.fn();
const appliedSchemaHeadsForApp = vi.fn();
const cloudApiFetch = vi.fn();

vi.mock("../../../src/gateway/services/cloudSync/webReady.js", () => ({ webReady }));
vi.mock("../../../src/gateway/services/syncV3/AppOpsClient.js", () => ({ fetchAppRepoHead }));
vi.mock("../../../src/gateway/services/cloudSync/publishSchemaSnapshots.js", () => ({
  appliedSchemaHeadsForApp,
}));
vi.mock("../../../src/gateway/utils/cloudApiClient.js", () => ({ cloudApiFetch }));

const { markPublishComplete } = await import(
  "../../../src/gateway/services/cloudSync/publishCompletion.js"
);

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("markPublishComplete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webReady.mockResolvedValue({ ready: true });
    fetchAppRepoHead.mockResolvedValue({ commitSha: SHA, files: [] });
    appliedSchemaHeadsForApp.mockResolvedValue({ "db-1": "0003_add_cards" });
    cloudApiFetch.mockResolvedValue(new Response("{}", { status: 200 }));
  });

  it("reports the writer HEAD commit and applied schema once web-ready", async () => {
    const out = await markPublishComplete("app-1");
    expect(out).toEqual({ recorded: true, commit: SHA });
    expect(fetchAppRepoHead).toHaveBeenCalledWith("app-1", { seedOidCache: false });
    expect(cloudApiFetch).toHaveBeenCalledWith(
      "/v1/cloud/apps/publish/app-1/complete",
      expect.objectContaining({
        method: "POST",
        body: { commit: SHA, dbSchema: { "db-1": "0003_add_cards" } },
      }),
    );
  });

  it("does nothing until code and database are both live", async () => {
    webReady.mockResolvedValue({ ready: false, reason: "writer_pending" });
    const out = await markPublishComplete("app-1");
    expect(out.recorded).toBe(false);
    expect(cloudApiFetch).not.toHaveBeenCalled();
  });

  it("never throws: old memory servers (404) and network errors are logged only", async () => {
    cloudApiFetch.mockResolvedValue(new Response("Not Found", { status: 404 }));
    expect((await markPublishComplete("app-1")).reason).toBe("HTTP 404");
    cloudApiFetch.mockRejectedValue(new Error("ECONNRESET"));
    expect((await markPublishComplete("app-1")).recorded).toBe(false);
  });

  it("still records when schema heads can't be read", async () => {
    appliedSchemaHeadsForApp.mockRejectedValue(new Error("db locked"));
    await markPublishComplete("app-1");
    expect(cloudApiFetch.mock.calls[0][1].body).toEqual({ commit: SHA, dbSchema: {} });
  });
});
