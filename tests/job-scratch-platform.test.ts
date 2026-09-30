import { describe, expect, it } from "vitest";
import { isJobScratchDatabasePath } from "../src/gateway/services/jobs/jobScratchDatabasePath.js";
import { isTursoLocalDatabaseCorruptError } from "../src/gateway/services/tursoSyncBridgeCore.js";
import { resolveJobTursoSyncKeysForBookends } from "../src/gateway/services/jobTursoSyncBookends.js";

describe("isJobScratchDatabasePath", () => {
  it("recognizes Jobs/{id}/data/data.db", () => {
    expect(
      isJobScratchDatabasePath(
        "/Users/me/Papr/Jobs/51f1493e/data/data.db",
      ),
    ).toBe(true);
  });

  it("rejects registry database paths", () => {
    expect(
      isJobScratchDatabasePath(
        "/Users/me/Papr/data/databases/lead-prospector/data.db",
      ),
    ).toBe(false);
  });
});

describe("isTursoLocalDatabaseCorruptError", () => {
  it("includes sync engine invalid page type", () => {
    expect(
      isTursoLocalDatabaseCorruptError("Invalid page type: 0"),
    ).toBe(true);
  });
});

describe("resolveJobTursoSyncKeysForBookends", () => {
  it("uses only writeDbIds when set, ignoring resolved job UUID", () => {
    expect(
      resolveJobTursoSyncKeysForBookends(
        {
          id: "51f1493e-2626-4428-8594-6bb7d92f9feb",
          writeDbIds: ["db-d97ad90c"],
        },
        ["51f1493e-2626-4428-8594-6bb7d92f9feb", "db-d97ad90c"],
      ),
    ).toEqual(["db-d97ad90c"]);
  });

  it("passes through resolved keys when writeDbIds empty", () => {
    expect(
      resolveJobTursoSyncKeysForBookends(
        { id: "job-scratch", writeDbIds: [] },
        ["job-scratch"],
      ),
    ).toEqual(["job-scratch"]);
  });
});
