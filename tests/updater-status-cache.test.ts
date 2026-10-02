import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  mergeUpdateStatusCache,
  shouldReplaceCachedUpdateStatus,
} = require("../src/electron/updaterStatusCache.cjs") as {
  mergeUpdateStatusCache: (
    current: { status: string } | null,
    next: { status: string },
  ) => { status: string };
  shouldReplaceCachedUpdateStatus: (
    current: { status: string } | null,
    next: { status: string },
  ) => boolean;
};

describe("updaterStatusCache", () => {
  it("does not let not-available overwrite ready", () => {
    expect(
      shouldReplaceCachedUpdateStatus({ status: "ready" }, { status: "not-available" }),
    ).toBe(false);
    expect(
      mergeUpdateStatusCache({ status: "ready", version: "2.6.24" }, { status: "not-available" })
        .status,
    ).toBe("ready");
  });

  it("does not let checking overwrite downloading", () => {
    expect(
      shouldReplaceCachedUpdateStatus({ status: "downloading" }, { status: "checking" }),
    ).toBe(false);
  });

  it("allows ready to replace downloading", () => {
    expect(
      mergeUpdateStatusCache({ status: "downloading", percent: 50 }, { status: "ready", version: "2.6.24" })
        .status,
    ).toBe("ready");
  });
});
