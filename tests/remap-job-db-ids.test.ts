import { describe, expect, it } from "vitest";
import {
  remapDbIdsInText,
  remapJobRecordDbIds,
  remapWriteDbIds,
} from "../src/gateway/services/jobs/remapJobDbIds.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";

describe("remapJobDbIds", () => {
  const remap = new Map([
    ["db-9354d2e8", "db-7ee69ac0"],
  ]);

  it("remaps writeDbIds and command text", () => {
    const job: JobRecord = {
      id: "11111111-1111-1111-1111-111111111111",
      name: "Harvest",
      type: "agent",
      status: "pending",
      appIds: ["app"],
      writeDbIds: ["db-9354d2e8"],
      command:
        'Use papr_db_exec on db-9354d2e8 with sql "SELECT 1" and writeDbIds db-9354d2e8',
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const next = remapJobRecordDbIds(job, remap);
    expect(next.writeDbIds).toEqual(["db-7ee69ac0"]);
    expect(next.command).not.toContain("db-9354d2e8");
    expect(next.command).toContain("db-7ee69ac0");
  });

  it("remapDbIdsInText leaves unknown ids", () => {
    expect(remapDbIdsInText("db-aaaaaaaa", remap)).toBe("db-aaaaaaaa");
  });

  it("remapWriteDbIds returns copy when unchanged", () => {
    const ids = ["db-7ee69ac0"];
    expect(remapWriteDbIds(ids, remap)).toEqual(ids);
  });
});
