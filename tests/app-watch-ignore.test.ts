import { describe, expect, it } from "vitest";
import { shouldIgnoreAppWatchPath } from "../src/gateway/services/appWatchIgnore.js";

describe("shouldIgnoreAppWatchPath", () => {
  it("ignores dependency and build trees", () => {
    expect(shouldIgnoreAppWatchPath("/apps/foo/node_modules/lodash/index.js")).toBe(true);
    expect(shouldIgnoreAppWatchPath("/apps/foo/.venv/lib/python3.12/site-packages/x.py")).toBe(
      true,
    );
    expect(shouldIgnoreAppWatchPath("/apps/foo/data/cache.db")).toBe(true);
    expect(shouldIgnoreAppWatchPath("/apps/foo/build/out.js")).toBe(true);
    expect(shouldIgnoreAppWatchPath("/apps/foo/dist/bundle.js")).toBe(true);
  });

  it("still watches app source files", () => {
    expect(shouldIgnoreAppWatchPath("/apps/foo/src/App.tsx")).toBe(false);
    expect(shouldIgnoreAppWatchPath("/apps/foo/index.html")).toBe(false);
  });
});
