import { describe, expect, it } from "vitest";
import { isParkedReplicaError } from "./flushAppNow.js";

// A parked replica (sync paused for the session after repeated engine aborts)
// must not abort Publish for apps that merely link that database.
describe("isParkedReplicaError", () => {
  it("matches the TursoReplicaSyncWorkerClient parked message", () => {
    expect(
      isParkedReplicaError(
        "Turso replica /x/Jobs/b6d2f0ea/data/data.db is parked for this session: " +
          "it aborted the sync engine 6 times in a row and no remedy cleared it. " +
          "Sync is paused for this database; local reads and writes still work. Restart the app to try again.",
      ),
    ).toBe(true);
  });

  it("does not swallow real push failures", () => {
    expect(isParkedReplicaError("Turso push failed: migration conflict")).toBe(false);
    expect(isParkedReplicaError("database is busy")).toBe(false);
    expect(isParkedReplicaError(undefined)).toBe(false);
    expect(isParkedReplicaError(null)).toBe(false);
  });
});
