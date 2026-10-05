import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gateway/services/tursoLinkedSources.js", () => ({
  listAppIdsLinkingSyncKey: vi.fn((key: string) => (key === "db-1" ? ["app-a", "app-b"] : [])),
}));

import {
  addMigrationToHold,
  resetReplicaPublishHoldsForTests,
} from "../src/gateway/services/tursoReplica/replicaPublishHold.js";
import { appIdsForHeldDatabases } from "../src/gateway/services/tursoReplica/scheduleHeldPublishes.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
  process.env.PAPR_HOME = root;
  resetReplicaPublishHoldsForTests();
});
afterEach(() => {
  delete process.env.PAPR_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("scheduleHeldPublishes", () => {
  it("returns nothing when no database is held", async () => {
    expect(await appIdsForHeldDatabases(root)).toEqual([]);
  });

  it("publishes every app linking a held database (shared db → all its apps)", async () => {
    addMigrationToHold({
      localPath: path.join(root, "a.db"),
      dbId: "db-1",
      migration: { migrationId: "m", sql: "DROP TABLE x", breaking: true },
    });
    expect((await appIdsForHeldDatabases(root)).sort()).toEqual(["app-a", "app-b"]);
  });
});
