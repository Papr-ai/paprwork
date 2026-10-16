import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reinit = vi.fn(async () => undefined);
const seed = vi.fn(async () => [] as string[]);
const headCheck = vi.fn(async () => true);
const hydrate = vi.fn(async () => ({ hydrated: 0, source: "skipped" as const }));

vi.mock("./reinitializeWorkspaceServices.js", () => ({
  reinitializeWorkspaceServicesForCloudRun: reinit,
}));
vi.mock("./seedCloudDatabaseRegistry.js", () => ({ seedCloudDatabaseRegistry: seed }));
vi.mock("./prepareCloudJobEnvironment.js", () => ({ prepareCloudJobEnvironment: vi.fn(async () => undefined) }));
vi.mock("./appRepoCloneCache.js", () => ({ isWarmWorkspaceFresh: headCheck }));
vi.mock("./hydrateSubAgentsRegistryForCloudRun.js", () => ({
  hydrateSubAgentsRegistryForCloudRun: hydrate,
  applySubAgentsHydrationFromMongo: vi.fn(async () => 0),
}));
vi.mock("./cloudSandboxTursoDirect.js", () => ({ shouldUseCloudSandboxTursoDirect: () => true }));
vi.mock("./cloudAppWriterDebouncedPush.js", () => ({
  disableCloudAppWriterForRun: vi.fn(),
  getCloudAppWriterPushedAppIds: () => [],
  startCloudAppWriterDebouncedPush: vi.fn(async () => null),
}));

const ctx = await import("./cloudAgentRunContext.js");

describe("warm session reuse", () => {
  let runRoot: string;
  const request = {
    runId: "r1",
    workspaceSessionId: "s1",
    jobId: "j1",
    userId: "u1",
    orgId: "o1",
    namespaceId: "n1",
    paprApiKey: "key-abcdefghijkl",
    workspaceScope: "app",
    appId: "a1",
    appRepoOwner: "papr-work",
    appRepoName: "app-a1",
    repoToken: "t",
    tursoSources: [],
  } as never;
  const paprHome = () => path.join(runRoot, "Papr", "orgs", "o1", "namespaces", "n1");

  beforeEach(async () => {
    runRoot = await mkdtemp(path.join(os.tmpdir(), "papr-cloud-session-test-"));
    await mkdir(paprHome(), { recursive: true });
    ctx.resetBoundCloudWorkspaceForTests();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await rm(runRoot, { recursive: true, force: true });
  });

  it("warm prebinds services so turns skip re-init", async () => {
    const warm = await ctx.beginCloudAgentRun(request, {
      skipClone: true, runRoot, prepOnly: true, prebindServices: true,
    });
    await warm.finish({ deleteWorkspace: false, prepOnly: true });
    expect(reinit).toHaveBeenCalledTimes(1);
    expect(ctx.isCloudWorkspaceBoundForTests(request, paprHome())).toBe(true);
    expect(headCheck).toHaveBeenCalledTimes(1); // warm verifies the workspace once
    headCheck.mockClear();
    hydrate.mockClear();

    for (let turn = 0; turn < 2; turn++) {
      const h = await ctx.beginCloudAgentRun(request, { skipClone: true, runRoot, trustWarmWorkspace: true });
      await h.finish({ deleteWorkspace: false });
    }
    expect(reinit).toHaveBeenCalledTimes(1);
    expect(headCheck).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("different caller identity rebinds", async () => {
    const h1 = await ctx.beginCloudAgentRun(request, { skipClone: true, runRoot, trustWarmWorkspace: true });
    await h1.finish({ deleteWorkspace: false });
    const other = { ...(request as object), userId: "u2" } as never;
    const h2 = await ctx.beginCloudAgentRun(other, { skipClone: true, runRoot, trustWarmWorkspace: true });
    await h2.finish({ deleteWorkspace: false });
    expect(reinit).toHaveBeenCalledTimes(2);
  });

  it("untrusted turn still checks remote HEAD", async () => {
    const h = await ctx.beginCloudAgentRun(request, { skipClone: true, runRoot });
    await h.finish({ deleteWorkspace: false });
    expect(headCheck).toHaveBeenCalledTimes(1);
  });

  it("forgetting the workspace forces a rebind", async () => {
    const h1 = await ctx.beginCloudAgentRun(request, { skipClone: true, runRoot, trustWarmWorkspace: true });
    await h1.finish({ deleteWorkspace: false });
    ctx.forgetBoundCloudWorkspace(runRoot);
    const h2 = await ctx.beginCloudAgentRun(request, { skipClone: true, runRoot, trustWarmWorkspace: true });
    await h2.finish({ deleteWorkspace: false });
    expect(reinit).toHaveBeenCalledTimes(2);
  });
});
