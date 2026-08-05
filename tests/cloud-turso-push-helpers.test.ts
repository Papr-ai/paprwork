import { describe, expect, it } from "vitest";
import {
  isSkippedEmptyTursoTarget,
  tursoTargetHasLocalData,
} from "../src/gateway/services/cloudAgentGateway/cloudTursoPushHelpers.js";

describe("cloud Turso push helpers", () => {
  it("treats empty local db as skippable", () => {
    expect(
      isSkippedEmptyTursoTarget({
        status: "skipped",
        tables: [],
        reason: "local_db_empty",
      }),
    ).toBe(true);
  });

  it("does not treat real push failures as skippable", () => {
    expect(
      isSkippedEmptyTursoTarget({
        status: "skipped",
        tables: [],
        reason: "turso_error",
      }),
    ).toBe(false);
  });

  it("reports no local data for missing db path", () => {
    expect(tursoTargetHasLocalData("/tmp/does-not-exist/data.db")).toBe(false);
  });
});
