import { describe, expect, test } from "vitest";
import {
  assertCreateAppIds,
  dedupeAppIds,
  isStandaloneOnly,
  jobBelongsToApp,
  mergeJobAppIds,
  STANDALONE_APP_ID,
} from "../src/gateway/services/jobs/appIds.js";

describe("job appIds helpers", () => {
  test("assertCreateAppIds requires at least one id", () => {
    expect(() => assertCreateAppIds(undefined)).toThrow(/appIds is required/);
    expect(() => assertCreateAppIds([])).toThrow(/appIds is required/);
    expect(assertCreateAppIds(["app-1"])).toEqual(["app-1"]);
  });

  test("dedupeAppIds trims and dedupes", () => {
    expect(dedupeAppIds(["a", " a ", "b", "a"])).toEqual(["a", "b"]);
  });

  test("mergeJobAppIds drops standalone when real apps added", () => {
    expect(mergeJobAppIds([STANDALONE_APP_ID], ["app-1"])).toEqual(["app-1"]);
    expect(mergeJobAppIds(["app-1"], ["app-2", "app-1"])).toEqual([
      "app-1",
      "app-2",
    ]);
    expect(mergeJobAppIds(undefined, [])).toEqual([STANDALONE_APP_ID]);
  });

  test("jobBelongsToApp and isStandaloneOnly", () => {
    expect(jobBelongsToApp(["app-1", "app-2"], "app-2")).toBe(true);
    expect(jobBelongsToApp([STANDALONE_APP_ID], "app-1")).toBe(false);
    expect(isStandaloneOnly([STANDALONE_APP_ID])).toBe(true);
    expect(isStandaloneOnly(["app-1"])).toBe(false);
  });
});
