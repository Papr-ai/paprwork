import { describe, expect, it } from "vitest";
import {
  isJobOwnedDatabasePath,
} from "../src/gateway/services/databasePromotion.js";
import { getPaprJobsRoot } from "../src/core/utils/paprRoot.js";
import path from "path";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("databasePromotion", () => {
  // Keeps fixtures out of the developer's real ~/Papr workspace.
  useIsolatedPaprWorkspace("database-promotion");

  it("isJobOwnedDatabasePath detects job folder databases", () => {
    const jobsRoot = getPaprJobsRoot();
    const jobDb = path.join(jobsRoot, "abc-123", "data", "data.db");
    const registryDb = path.join("/tmp/Papr/data/databases/crm/data.db");
    expect(isJobOwnedDatabasePath(jobDb)).toBe(true);
    expect(isJobOwnedDatabasePath(registryDb)).toBe(false);
  });
});
