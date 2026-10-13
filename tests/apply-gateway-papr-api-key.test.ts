import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * applyGatewayPaprApiKey runs on every launch and every login sync. Re-applying
 * the same key must not rebuild storage/agent or touch Turso tokens; a key for
 * another workspace must still be rejected.
 */

const ORG = "orgAAAAAAAA";
const NS = "nsAAAAAAAAA";
const KEY_A = `sk-org-${ORG}-namespace-${NS}-secret1`;
const KEY_A2 = `sk-org-${ORG}-namespace-${NS}-secret2`;
const KEY_OTHER = "sk-org-orgBBBBBBBB-namespace-nsBBBBBBBBB-secret";

const resetStorage = vi.fn(async () => undefined);
const initAgent = vi.fn(async () => ({}));
const invalidateCreds = vi.fn();

function mockDeps() {
  vi.doMock("../src/core/utils/paprWorkspace.js", async (orig) => ({
    ...(await orig<object>()),
    readActiveWorkspacePointer: () => ({
      organizationId: ORG,
      namespaceId: NS,
      paprHome: "/tmp/x",
      userDataPath: "/tmp/x",
      activatedAt: new Date().toISOString(),
    }),
  }));
  vi.doMock("../src/gateway/services/StorageManager.js", async (orig) => ({
    ...(await orig<object>()),
    resetStorageManagerSingleton: resetStorage,
  }));
  vi.doMock("../src/gateway/services/AgentService.js", async (orig) => ({
    ...(await orig<object>()),
    initializeAgentService: initAgent,
    resetAgentServiceSingletonForTests: vi.fn(),
    getAgentService: () => ({}),
  }));
  vi.doMock("../src/gateway/services/TursoSyncBridge.js", async (orig) => ({
    ...(await orig<object>()),
    getTursoSyncBridge: () => ({ invalidateCredentialsCache: invalidateCreds }),
  }));
  vi.doMock("../src/gateway/services/CodeIndexingService.js", async (orig) => ({
    ...(await orig<object>()),
    ensureIndexingStarted: vi.fn(async () => undefined),
  }));
  vi.doMock("../src/gateway/services/AgentStreamRegistry.js", async (orig) => ({
    ...(await orig<object>()),
    getAgentStreamRegistry: () => ({ listActive: () => [], abortAll: async () => undefined }),
  }));
}

describe("applyGatewayPaprApiKey", () => {
  const savedKey = process.env.PAPR_API_KEY;

  beforeEach(() => {
    vi.resetModules();
    resetStorage.mockClear();
    initAgent.mockClear();
    invalidateCreds.mockClear();
    mockDeps();
  });

  afterEach(() => {
    vi.resetModules();
    if (savedKey === undefined) delete process.env.PAPR_API_KEY;
    else process.env.PAPR_API_KEY = savedKey;
  });

  it("first apply reinitialises; re-applying the same key is a no-op", async () => {
    const mod = await import("../src/gateway/services/workspaceSwitchService.js");
    mod.resetLastAppliedPaprApiKeyForTests();

    await mod.applyGatewayPaprApiKey(KEY_A);
    expect(resetStorage).toHaveBeenCalledTimes(1);
    expect(initAgent).toHaveBeenCalledTimes(1);

    await mod.applyGatewayPaprApiKey(KEY_A);
    await mod.applyGatewayPaprApiKey(` ${KEY_A} `);
    expect(resetStorage).toHaveBeenCalledTimes(1);
    expect(initAgent).toHaveBeenCalledTimes(1);
    expect(invalidateCreds).toHaveBeenCalledTimes(1);
  });

  it("a rotated key in the same workspace reinitialises but only clears in-memory tokens", async () => {
    const mod = await import("../src/gateway/services/workspaceSwitchService.js");
    mod.resetLastAppliedPaprApiKeyForTests();

    await mod.applyGatewayPaprApiKey(KEY_A);
    await mod.applyGatewayPaprApiKey(KEY_A2);
    expect(initAgent).toHaveBeenCalledTimes(2);
    // Called with no database name → in-memory only (persisted store kept).
    expect(invalidateCreds).toHaveBeenCalledTimes(2);
    for (const call of invalidateCreds.mock.calls) {
      expect(call).toEqual([]);
    }
    expect(process.env.PAPR_API_KEY).toBe(KEY_A2);
  });

  it("still rejects a key for a different workspace, even after a successful apply", async () => {
    const mod = await import("../src/gateway/services/workspaceSwitchService.js");
    mod.resetLastAppliedPaprApiKeyForTests();

    await mod.applyGatewayPaprApiKey(KEY_A);
    await expect(mod.applyGatewayPaprApiKey(KEY_OTHER)).rejects.toThrow(
      /does not match the active workspace/,
    );
    expect(process.env.PAPR_API_KEY).toBe(KEY_A);
    expect(initAgent).toHaveBeenCalledTimes(1);
  });
});
