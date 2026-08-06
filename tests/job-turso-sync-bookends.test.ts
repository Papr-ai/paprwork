import { describe, expect, it } from "vitest";
import { resolveJobTursoSyncKeys } from "../src/gateway/services/jobTursoSyncBookends.js";

describe("resolveJobTursoSyncKeys", () => {
  it("uses writeDbIds when present", () => {
    expect(
      resolveJobTursoSyncKeys({
        id: "51abf434-1d0f-4f14-8111-fabe8eedf224",
        writeDbIds: ["db-2d6b4294"],
      }),
    ).toEqual(["db-2d6b4294"]);
  });

  it("falls back to job id for scratch-only jobs", () => {
    expect(
      resolveJobTursoSyncKeys({
        id: "job-scratch-1",
        writeDbIds: [],
      }),
    ).toEqual(["job-scratch-1"]);
  });

  it("deduplicates multiple writeDbIds", () => {
    expect(
      resolveJobTursoSyncKeys({
        id: "job-1",
        writeDbIds: ["db-a", "db-a", " db-b "],
      }),
    ).toEqual(["db-a", "db-b"]);
  });
});
