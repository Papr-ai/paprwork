import { describe, expect, it } from "vitest";
import {
  getDatabaseRegistryService,
  resetDatabaseRegistryForWorkspaceSwitch,
} from "../src/gateway/services/DatabaseRegistryService.js";

const rec = (dbId: string, localPath: string) => ({
  dbId, localPath, tursoShortName: dbId.replace("db-", "d-"), isolation: "shared",
  status: "active", syncMode: "replica",
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
});

describe("mergeFromRegistryFile keeps replica mode for cloud records", () => {
  it("keeps syncMode=replica when localPath is blank (cloud copy)", () => {
    resetDatabaseRegistryForWorkspaceSwitch();
    const reg = getDatabaseRegistryService();
    reg.mergeFromRegistryFile(JSON.stringify({ version: 1, databases: { "db-aaaa1111": rec("db-aaaa1111", "") } }));
    expect(reg.getById("db-aaaa1111")?.syncMode).toBe("replica");
  });
  it("still drops replica mode for job scratch paths", () => {
    resetDatabaseRegistryForWorkspaceSwitch();
    const reg = getDatabaseRegistryService();
    const scratch = "/tmp/papr/Jobs/11111111-2222-3333-4444-555555555555/data/data.db";
    reg.mergeFromRegistryFile(JSON.stringify({ version: 1, databases: { "db-bbbb2222": rec("db-bbbb2222", scratch) } }));
    expect(reg.getById("db-bbbb2222")?.syncMode).toBeUndefined();
  });
});
