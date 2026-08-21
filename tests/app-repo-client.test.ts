import { afterEach, describe, expect, test } from "vitest";
import {
  parseAppRepoRecord,
  type AppRepoRecord,
} from "../src/core/types/appRepoRegistry.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

const sampleRecord: AppRepoRecord = {
  appId: "app-abc",
  namespaceId: "ns-1",
  githubOrg: "papr-shard-0001",
  repoName: "app-app-abc",
  shardId: "0001",
  cloneUrl: "https://github.com/papr-shard-0001/app-app-abc.git",
  repoUrl: "https://github.com/papr-shard-0001/app-app-abc",
  createdAt: "2026-08-18T12:00:00.000Z",
};

describe("appRepoRegistry types", () => {
  test("parseAppRepoRecord accepts snake_case API payload", () => {
    const record = parseAppRepoRecord({
      app_id: sampleRecord.appId,
      namespace_id: sampleRecord.namespaceId,
      github_org: sampleRecord.githubOrg,
      repo_name: sampleRecord.repoName,
      shard_id: sampleRecord.shardId,
      clone_url: sampleRecord.cloneUrl,
      repo_url: sampleRecord.repoUrl,
      created_at: sampleRecord.createdAt,
    });
    expect(record).toEqual(sampleRecord);
  });

  test("parseAppRepoRecord accepts camelCase payload", () => {
    expect(parseAppRepoRecord(sampleRecord)).toEqual(sampleRecord);
  });
});

describe("appRepoRegistryCache", () => {
  useIsolatedPaprWorkspace("app-repo-cache");

  afterEach(async () => {
    const { clearAppRepoRegistryCacheForTests } = await import(
      "../src/gateway/services/syncV3/appRepoRegistryCache.js"
    );
    await clearAppRepoRegistryCacheForTests();
  });

  test("upsert and read cached record", async () => {
    const { upsertCachedAppRepoRecord, getCachedAppRepoRecord } = await import(
      "../src/gateway/services/syncV3/appRepoRegistryCache.js"
    );
    await upsertCachedAppRepoRecord(sampleRecord);
    const cached = await getCachedAppRepoRecord(sampleRecord.appId);
    expect(cached?.cloneUrl).toBe(sampleRecord.cloneUrl);
  });
});

describe("AppRepoClient", () => {
  useIsolatedPaprWorkspace("app-repo-client");

  afterEach(async () => {
    const { clearAppRepoRegistryCacheForTests } = await import(
      "../src/gateway/services/syncV3/appRepoRegistryCache.js"
    );
    await clearAppRepoRegistryCacheForTests();
  });

  test("resolveAppRepoForSync returns null when Papr API unavailable", async () => {
    const { resolveAppRepoForSync } = await import(
      "../src/gateway/services/syncV3/AppRepoClient.js"
    );
    const result = await resolveAppRepoForSync("app-abc");
    expect(result).toBeNull();
  });

  test("cloneUrlMatchesAppRepo ignores token prefix", async () => {
    const { cloneUrlMatchesAppRepo } = await import(
      "../src/gateway/services/syncV3/AppRepoClient.js"
    );
    expect(
      cloneUrlMatchesAppRepo(
        "https://x-access-token:tok@github.com/papr-shard-0001/app-app-abc.git",
        sampleRecord,
      ),
    ).toBe(true);
  });
});
