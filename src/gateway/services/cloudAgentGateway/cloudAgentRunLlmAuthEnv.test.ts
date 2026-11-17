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


describe("run llmAuth reaches sub-agents", () => {
  let runRoot: string;
  const base = {
    runId: "r1", workspaceSessionId: "s1", jobId: "j1", userId: "u1", orgId: "o1", namespaceId: "n1",
    paprApiKey: "key-abcdefghijkl", tursoSources: [],
  };
  const paprHome = () => path.join(runRoot, "Papr", "orgs", "o1", "namespaces", "n1");
  const saved = { ...process.env };

  beforeEach(async () => {
    runRoot = await mkdtemp(path.join(os.tmpdir(), "papr-cloud-llmauth-test-"));
    await mkdir(paprHome(), { recursive: true });
    ctx.resetBoundCloudWorkspaceForTests();
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(async () => {
    process.env = { ...saved };
    await rm(runRoot, { recursive: true, force: true });
  });

  it("exposes the run's credential under the provider key and removes it after", async () => {
    const request = { ...base, llmAuth: { provider: "anthropic", authType: "oauth", token: "sk-ant-oat01-run" } } as never;
    const h = await ctx.beginCloudAgentRun(request, { skipClone: true, runRoot });
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-oat01-run");
    await h.finish({ deleteWorkspace: false });
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("does not override a vault key for the same provider", async () => {
    const request = {
      ...base,
      vaultKeys: { ANTHROPIC_API_KEY: "sk-ant-vault" },
      llmAuth: { provider: "anthropic", authType: "oauth", token: "sk-ant-oat01-run" },
    } as never;
    const h = await ctx.beginCloudAgentRun(request, { skipClone: true, runRoot });
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-vault");
    await h.finish({ deleteWorkspace: false });
  });
});
