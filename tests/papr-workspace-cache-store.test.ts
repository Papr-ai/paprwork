import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Redirect the cache to a temp dir. Declared before the factory runs but only
// read when getPaprBaseDir is actually called, which is inside the tests.
let baseDir: string;

vi.mock("../src/core/utils/paprWorkspace.js", () => ({
  getPaprBaseDir: () => baseDir,
}));

const {
  CACHE_FRESH_MS,
  CACHE_MAX_AGE_MS,
  clearPaprWorkspaceCache,
  readCachedNamespaces,
  readCachedWorkspaces,
  writeCachedNamespaces,
  writeCachedWorkspaces,
} = await import("../src/electron/ipc/paprWorkspaceCache.js");

const USER = "user-1";
const OTHER_USER = "user-2";

function cacheFilePath(): string {
  return path.join(baseDir, "data", "papr-workspace-cache.json");
}

function readFileRaw(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(cacheFilePath(), "utf8")) as Record<
    string,
    unknown
  >;
}

function workspace(id: string, name: string, defaultNamespaceId = "ns-1") {
  return { id, name, organizationId: "org-1", defaultNamespaceId };
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-cache-store-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-17T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe("workspace cache persistence", () => {
  it("round-trips workspaces for the user that wrote them", () => {
    writeCachedWorkspaces(USER, [workspace("a", "Papr")]);

    const read = readCachedWorkspaces(USER);
    expect(read?.data.map((entry) => entry.name)).toEqual(["Papr"]);
    expect(read?.isStale).toBe(false);
    expect(read?.ageMs).toBe(0);
  });

  it("returns null when nothing has been cached", () => {
    expect(readCachedWorkspaces(USER)).toBeNull();
  });

  // The bug this cache shipped with: dedupe ran on write, so a wrong transform
  // erased rows on disk and no later fix could recover them.
  it("stores rows verbatim and only dedupes on read", () => {
    writeCachedWorkspaces(USER, [
      workspace("a", "Papr"),
      workspace("b", "Papr"),
    ]);

    expect(readCachedWorkspaces(USER)?.data).toHaveLength(1);
    expect(readFileRaw().workspaces).toHaveLength(2);
  });

  it("never serves another account's cache", () => {
    writeCachedWorkspaces(USER, [workspace("a", "Papr")]);

    expect(readCachedWorkspaces(OTHER_USER)).toBeNull();
    expect(readCachedNamespaces(OTHER_USER, "org-1")).toBeNull();
  });

  it("ignores a pre-v3 file, which carries no owner", () => {
    fs.mkdirSync(path.dirname(cacheFilePath()), { recursive: true });
    fs.writeFileSync(
      cacheFilePath(),
      JSON.stringify({
        version: 2,
        updatedAt: new Date().toISOString(),
        workspaces: [workspace("a", "Papr")],
        namespacesByOrgId: {},
      }),
      "utf8",
    );

    expect(readCachedWorkspaces(USER)).toBeNull();
  });

  // v3 rows predate memberCount/isOrgPrimary, so serving them would collapse
  // duplicate workspaces by arrival order and keep picking the wrong one.
  it("ignores a v3 file, whose rows cannot rank duplicates", () => {
    fs.mkdirSync(path.dirname(cacheFilePath()), { recursive: true });
    fs.writeFileSync(
      cacheFilePath(),
      JSON.stringify({
        version: 3,
        userId: USER,
        workspacesFetchedAt: new Date().toISOString(),
        workspaces: [workspace("a", "Papr")],
        namespacesByOrgId: {},
      }),
      "utf8",
    );

    expect(readCachedWorkspaces(USER)).toBeNull();
  });

  it("treats a corrupt file as a miss and recovers on the next write", () => {
    fs.mkdirSync(path.dirname(cacheFilePath()), { recursive: true });
    fs.writeFileSync(cacheFilePath(), "{ truncated", "utf8");

    expect(readCachedWorkspaces(USER)).toBeNull();

    writeCachedWorkspaces(USER, [workspace("a", "Papr")]);
    expect(readCachedWorkspaces(USER)?.data).toHaveLength(1);
  });

  it("marks a cache past the freshness window as stale but still usable", () => {
    writeCachedWorkspaces(USER, [workspace("a", "Papr")]);
    vi.advanceTimersByTime(CACHE_FRESH_MS + 1_000);

    const read = readCachedWorkspaces(USER);
    expect(read?.data).toHaveLength(1);
    expect(read?.isStale).toBe(true);
  });

  it("treats a cache past the max age as a miss", () => {
    writeCachedWorkspaces(USER, [workspace("a", "Papr")]);
    vi.advanceTimersByTime(CACHE_MAX_AGE_MS + 1_000);

    expect(readCachedWorkspaces(USER)).toBeNull();
  });

  it("refuses to replace a populated workspace list with an empty one", () => {
    writeCachedWorkspaces(USER, [workspace("a", "Papr"), workspace("b", "Acme", "ns-2")]);
    writeCachedWorkspaces(USER, []);

    expect(readCachedWorkspaces(USER)?.data).toHaveLength(2);
  });

  it("accepts a smaller non-empty list as a real membership change", () => {
    writeCachedWorkspaces(USER, [workspace("a", "Papr"), workspace("b", "Acme", "ns-2")]);
    writeCachedWorkspaces(USER, [workspace("a", "Papr")]);

    expect(readCachedWorkspaces(USER)?.data.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("writes the first list even though it grows from nothing", () => {
    writeCachedWorkspaces(USER, []);
    expect(readCachedWorkspaces(USER)).toBeNull();

    writeCachedWorkspaces(USER, [workspace("a", "Papr")]);
    expect(readCachedWorkspaces(USER)?.data).toHaveLength(1);
  });
});

describe("namespace cache persistence", () => {
  it("round-trips namespaces per organization", () => {
    writeCachedNamespaces(USER, "org-1", [{ id: "ns-1", name: "prod" }]);

    expect(readCachedNamespaces(USER, "org-1")?.data).toEqual([
      { id: "ns-1", name: "prod" },
    ]);
    expect(readCachedNamespaces(USER, "org-2")).toBeNull();
  });

  it("ages each organization independently", () => {
    writeCachedNamespaces(USER, "org-1", [{ id: "ns-1", name: "prod" }]);
    vi.advanceTimersByTime(CACHE_FRESH_MS + 1_000);
    writeCachedNamespaces(USER, "org-2", [{ id: "ns-2", name: "dev" }]);

    expect(readCachedNamespaces(USER, "org-1")?.isStale).toBe(true);
    expect(readCachedNamespaces(USER, "org-2")?.isStale).toBe(false);
  });

  it("refuses to replace populated namespaces with an empty list", () => {
    writeCachedNamespaces(USER, "org-1", [{ id: "ns-1", name: "prod" }]);
    writeCachedNamespaces(USER, "org-1", []);

    expect(readCachedNamespaces(USER, "org-1")?.data).toHaveLength(1);
  });

  it("keeps namespaces when the workspace list is rewritten", () => {
    writeCachedNamespaces(USER, "org-1", [{ id: "ns-1", name: "prod" }]);
    writeCachedWorkspaces(USER, [workspace("a", "Papr")]);

    expect(readCachedNamespaces(USER, "org-1")?.data).toHaveLength(1);
  });

  // Entries accumulated forever before this, which is how a cache ends up with
  // more organizations than the user has workspaces.
  it("prunes namespace entries past the max age on the next write", () => {
    writeCachedNamespaces(USER, "org-old", [{ id: "ns-old", name: "old" }]);
    vi.advanceTimersByTime(CACHE_MAX_AGE_MS + 1_000);

    writeCachedWorkspaces(USER, [workspace("a", "Papr")]);

    expect(readFileRaw().namespacesByOrgId).toEqual({});
  });
});

describe("clearPaprWorkspaceCache", () => {
  it("removes the cache so the next account starts clean", () => {
    writeCachedWorkspaces(USER, [workspace("a", "Papr")]);
    clearPaprWorkspaceCache();

    expect(fs.existsSync(cacheFilePath())).toBe(false);
    expect(readCachedWorkspaces(USER)).toBeNull();
  });

  it("is safe to call when no cache exists", () => {
    expect(() => clearPaprWorkspaceCache()).not.toThrow();
  });
});
