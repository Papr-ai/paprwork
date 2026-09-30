import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAppDataSourcesCacheSignature,
  clearAppDataSourcesConfigCacheDiagnostics,
  getCachedAppDataSourcesResolvedConfig,
  invalidateAppDataSourcesConfigCache,
  setCachedAppDataSourcesResolvedConfig,
} from "../src/gateway/services/appDataSourcesResolvedCache.js";
import type { AppDataSourcesFile } from "../src/gateway/services/appDataSources.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "papr-ds-cache-"));
}

describe("appDataSourcesResolvedCache", () => {
  afterEach(() => {
    invalidateAppDataSourcesConfigCache();
    clearAppDataSourcesConfigCacheDiagnostics();
  });

  it("returns cached config when signature matches", () => {
    const root = tempDir();
    const appId = "app-1";
    const appsDir = path.join(root, "apps");
    const appDir = path.join(appsDir, appId);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "data-sources.json"),
      '{"sources":[]}',
      "utf8",
    );
    const registryPath = path.join(root, "databases.json");
    fs.writeFileSync(registryPath, '{"databases":{}}', "utf8");

    const input = {
      appId,
      appsDir,
      paprRoot: root,
      jobsRoot: path.join(root, "Jobs"),
      registryPath,
    };
    const sig = buildAppDataSourcesCacheSignature(input);
    const config: AppDataSourcesFile = { sources: [{ alias: "main", dbPath: "/x" }] };
    setCachedAppDataSourcesResolvedConfig(appId, sig, config);

    const hit = getCachedAppDataSourcesResolvedConfig(appId, sig);
    expect(hit?.sources[0]?.alias).toBe("main");
    hit!.sources[0]!.alias = "mutated";
    const hitAgain = getCachedAppDataSourcesResolvedConfig(appId, sig);
    expect(hitAgain?.sources[0]?.alias).toBe("main");
  });

  it("misses when data-sources.json changes", () => {
    const root = tempDir();
    const appId = "app-2";
    const appsDir = path.join(root, "apps");
    const appDir = path.join(appsDir, appId);
    fs.mkdirSync(appDir, { recursive: true });
    const dsPath = path.join(appDir, "data-sources.json");
    fs.writeFileSync(dsPath, '{"sources":[]}', "utf8");
    const registryPath = path.join(root, "databases.json");
    fs.writeFileSync(registryPath, "{}", "utf8");

    const input = {
      appId,
      appsDir,
      paprRoot: root,
      jobsRoot: path.join(root, "Jobs"),
      registryPath,
    };
    const sig1 = buildAppDataSourcesCacheSignature(input);
    setCachedAppDataSourcesResolvedConfig(appId, sig1, { sources: [] });

    fs.writeFileSync(dsPath, '{"sources":[{"alias":"a","dbPath":""}]}', "utf8");
    const sig2 = buildAppDataSourcesCacheSignature(input);
    expect(sig2).not.toBe(sig1);
    expect(getCachedAppDataSourcesResolvedConfig(appId, sig2)).toBeUndefined();
  });

  it("invalidates per app and globally", () => {
    const root = tempDir();
    const appsDir = path.join(root, "apps");
    const registryPath = path.join(root, "reg.json");
    fs.writeFileSync(registryPath, "{}", "utf8");

    for (const appId of ["a", "b"]) {
      const appDir = path.join(appsDir, appId);
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "data-sources.json"),
        '{"sources":[]}',
        "utf8",
      );
      const input = {
        appId,
        appsDir,
        paprRoot: root,
        jobsRoot: path.join(root, "Jobs"),
        registryPath,
      };
      const sig = buildAppDataSourcesCacheSignature(input);
      setCachedAppDataSourcesResolvedConfig(appId, sig, { sources: [] });
    }

    invalidateAppDataSourcesConfigCache("a");
    const inputA = {
      appId: "a",
      appsDir,
      paprRoot: root,
      jobsRoot: path.join(root, "Jobs"),
      registryPath,
    };
    const sigA = buildAppDataSourcesCacheSignature(inputA);
    expect(getCachedAppDataSourcesResolvedConfig("a", sigA)).toBeUndefined();

    const inputB = {
      appId: "b",
      appsDir,
      paprRoot: root,
      jobsRoot: path.join(root, "Jobs"),
      registryPath,
    };
    const sigB = buildAppDataSourcesCacheSignature(inputB);
    expect(getCachedAppDataSourcesResolvedConfig("b", sigB)).toBeDefined();

    invalidateAppDataSourcesConfigCache();
    expect(getCachedAppDataSourcesResolvedConfig("b", sigB)).toBeUndefined();
  });
});
