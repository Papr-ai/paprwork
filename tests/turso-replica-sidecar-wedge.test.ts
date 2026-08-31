import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectReplicaSidecarWedge, repairReplicaSidecarWedge } from "../src/gateway/services/tursoReplica/tursoReplicaSidecarWedge.js";

describe("tursoReplicaSidecarWedge", () => {
  it("detects empty WAL with non-zero watermark in sidecar info", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-wedge-"));
    const dbPath = path.join(dir, "data.db");
    fs.writeFileSync(dbPath, "sqlite");
    fs.writeFileSync(`${dbPath}-wal`, "");
    fs.writeFileSync(
      `${dbPath}-info`,
      JSON.stringify({
        revert_since_wal_watermark: 0,
        synced_revision: {
          revision: JSON.stringify({ wal_fragment_no: 85 }),
        },
      }),
    );

    expect(detectReplicaSidecarWedge(dbPath)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when WAL has frames", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-wedge-"));
    const dbPath = path.join(dir, "data.db");
    fs.writeFileSync(dbPath, "sqlite");
    fs.writeFileSync(`${dbPath}-wal`, "frame-data");
    fs.writeFileSync(
      `${dbPath}-info`,
      JSON.stringify({
        synced_revision: {
          revision: JSON.stringify({ wal_fragment_no: 85 }),
        },
      }),
    );

    expect(detectReplicaSidecarWedge(dbPath)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("repairReplicaSidecarWedge removes wedged sidecars and keeps data.db", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-wedge-repair-"));
    const dbPath = path.join(dir, "data.db");
    fs.writeFileSync(dbPath, "sqlite-data");
    fs.writeFileSync(`${dbPath}-wal`, "");
    fs.writeFileSync(
      `${dbPath}-info`,
      JSON.stringify({
        revert_since_wal_watermark: 12,
        synced_revision: {
          revision: JSON.stringify({ wal_fragment_no: 3 }),
        },
      }),
    );
    fs.writeFileSync(`${dbPath}-changes`, "{}");

    const repaired = repairReplicaSidecarWedge(dbPath);
    expect(repaired).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.readFileSync(dbPath, "utf8")).toBe("sqlite-data");
    expect(fs.existsSync(`${dbPath}-info`)).toBe(false);
    expect(detectReplicaSidecarWedge(dbPath)).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
