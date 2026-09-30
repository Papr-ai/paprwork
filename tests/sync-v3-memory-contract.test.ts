import { describe, expect, it } from "vitest";
import {
  SYNC_V3_OPENAPI_PATH_PATTERNS,
  verifySyncV3MemoryRoutes,
} from "../scripts/lib/syncV3MemoryContract.mjs";

describe("Sync V3 memory OpenAPI contract patterns", () => {
  it("matches expected FastAPI path templates", () => {
    const samplePaths = [
      "/v1/cloud/apps/{app_id}/repo",
      "/v1/cloud/apps/{app_id}/repo/ensure",
      "/v1/cloud/workspace/log/append",
      "/v1/cloud/workspace/log/since",
      "/v1/cloud/workspace/log/genesis",
      "/v1/cloud/runtime/scheduler-run-lease/acquire",
      "/v1/cloud/runtime/scheduler-run-lease/release",
      "/v1/cloud/apps/{app_id}/writer-lease/acquire",
      "/v1/cloud/apps/{app_id}/writer-lease/release",
      "/v1/cloud/runtime/dispatch/stream",
      "/v1/cloud/shards/status",
    ];

    for (const required of SYNC_V3_OPENAPI_PATH_PATTERNS) {
      const matched = samplePaths.some((path) => required.test(path));
      expect(matched, required.label).toBe(true);
    }
  });

  it("does not treat legacy namespace repo paths as app repo routes", () => {
    const legacy = ["/v1/cloud/repos/init", "/v1/cloud/repos/token"];
    const appRepoGet = SYNC_V3_OPENAPI_PATH_PATTERNS.find(
      (r) => r.id === "app_repo_get",
    );
    expect(appRepoGet).toBeDefined();
    for (const path of legacy) {
      expect(appRepoGet!.test(path)).toBe(false);
    }
  });

  it("verifySyncV3MemoryRoutes fails when required paths missing", async () => {
    const result = await verifySyncV3MemoryRoutes("http://127.0.0.1:1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing.length).toBeGreaterThan(0);
    }
  });
});
