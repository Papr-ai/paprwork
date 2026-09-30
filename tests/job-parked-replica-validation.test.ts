import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const PARKED =
  "Turso replica /x/data.db is parked: the abort came from inside data.db's own pages — re-seed this replica from the remote (repair_cloud_sync with accept_cloud) to clear it.";

vi.mock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
  schemaLinkedDbViaTursoReplica: vi.fn(async () => {
    throw new Error(PARKED);
  }),
}));

vi.mock("../src/gateway/utils/tursoReplicaEnabled.js", async (orig) => ({
  ...(await orig<object>()),
  isTursoReplicaSyncFeatureEnabled: () => true,
}));

import { readRegistryDatabaseSchema } from "../src/gateway/services/jobs/registryDbSchemaReader.js";
import { validateJobAgainstAppDatabase } from "../src/gateway/services/jobs/jobDatabaseArchitectureValidation.js";
import { isParkedReplicaError } from "../src/gateway/services/tursoReplica/tursoReplicaErrors.js";

const dirs: string[] = [];
function replicaFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "papr-parked-"));
  dirs.push(dir);
  const p = path.join(dir, "data.db");
  writeFileSync(p, "");
  return p;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parked replica during job validation", () => {
  it("classifies the parked error, not as unopenable", async () => {
    const result = await readRegistryDatabaseSchema({
      dbPath: replicaFile(),
      dbId: "db-1",
      syncMode: "replica",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("parked");
  });

  it("points at re-seeding, never at re-linking", async () => {
    const issues = await validateJobAgainstAppDatabase({
      databasePath: replicaFile(),
      dbId: "db-1",
      syncMode: "replica",
      command: "python3 save.py",
    } as Parameters<typeof validateJobAgainstAppDatabase>[0]);
    const parked = issues.find((i) => i.rule === "primary-database-parked");
    expect(parked?.severity).toBe("error");
    expect(issues.some((i) => i.rule === "primary-database-unopenable")).toBe(false);
    expect(parked?.remediation).toMatch(/accept_cloud/);
    expect(parked?.remediation).not.toMatch(/Restart Paprwork/);
  });

  it("matches both parked wordings and nothing else", () => {
    expect(isParkedReplicaError(PARKED)).toBe(true);
    expect(isParkedReplicaError(new Error("Turso replica /a is parked for this session: x"))).toBe(true);
    expect(isParkedReplicaError("database is locked")).toBe(false);
    expect(isParkedReplicaError(undefined)).toBe(false);
  });
});
