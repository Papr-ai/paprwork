import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMiniAppInInteractiveLoadWindow,
  markMiniAppInteractiveLoadWindow,
  resetMiniAppInteractiveLoadWindowForTests,
  shouldMiniAppUseReplicaOnlyForReads,
} from "../src/gateway/services/appRuntime/miniAppInteractiveLoadWindow.js";
import { shouldDeferReplicaPushWhileInteractive } from "../src/gateway/services/tursoReplica/tursoReplicaPushInteractiveDefer.js";

describe("miniAppInteractiveLoadWindow", () => {
  afterEach(() => {
    resetMiniAppInteractiveLoadWindowForTests();
    vi.unstubAllEnvs();
  });

  it("marks a load window and expires after MINI_APP_LOAD_WINDOW_MS", () => {
    vi.stubEnv("MINI_APP_LOAD_WINDOW_MS", "100");
    markMiniAppInteractiveLoadWindow("app-a");
    expect(isMiniAppInInteractiveLoadWindow("app-a")).toBe(true);
    expect(shouldMiniAppUseReplicaOnlyForReads("app-a")).toBe(true);
  });

  it("clears the window after MINI_APP_LOAD_WINDOW_MS=0", () => {
    vi.stubEnv("MINI_APP_LOAD_WINDOW_MS", "0");
    markMiniAppInteractiveLoadWindow("app-a");
    expect(isMiniAppInInteractiveLoadWindow("app-a")).toBe(false);
  });

  it("allows primary race when MINI_APP_LOAD_REPLICA_ONLY=false", () => {
    vi.stubEnv("MINI_APP_LOAD_WINDOW_MS", "60000");
    vi.stubEnv("MINI_APP_LOAD_REPLICA_ONLY", "false");
    markMiniAppInteractiveLoadWindow("app-a");
    expect(shouldMiniAppUseReplicaOnlyForReads("app-a")).toBe(false);
  });
});

describe("shouldDeferReplicaPushWhileInteractive", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never defers manual pushes", async () => {
    vi.stubEnv("TURSO_PUSH_DEFER_WHILE_INTERACTIVE", "true");
    await expect(
      shouldDeferReplicaPushWhileInteractive("manual"),
    ).resolves.toBe(false);
  });
});
