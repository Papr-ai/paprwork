import { describe, expect, it } from "vitest";
import path from "path";
import { shouldIgnoreAppWatchPath } from "../src/gateway/services/appWatchIgnore.js";

describe("shouldIgnoreAppWatchPath", () => {
  it("ignores metadata and build output paths (absolute paths from chokidar)", () => {
    const appDir = "/Users/me/Papr/orgs/o/n/apps/app-id";
    expect(shouldIgnoreAppWatchPath(path.join(appDir, "data-sources.json"))).toBe(
      true,
    );
    expect(
      shouldIgnoreAppWatchPath(path.join(appDir, "linked-databases.json")),
    ).toBe(true);
    expect(shouldIgnoreAppWatchPath(path.join(appDir, "dist", "app.js"))).toBe(
      true,
    );
    expect(
      shouldIgnoreAppWatchPath(path.join(appDir, ".versions", "abc.json")),
    ).toBe(true);
    expect(shouldIgnoreAppWatchPath(path.join(appDir, ".hidden"))).toBe(true);
  });

  it("does not ignore app source files", () => {
    const appDir = "/Users/me/Papr/orgs/o/n/apps/app-id";
    expect(shouldIgnoreAppWatchPath(path.join(appDir, "index.html"))).toBe(
      false,
    );
    expect(shouldIgnoreAppWatchPath(path.join(appDir, "app.ts"))).toBe(false);
  });
});
