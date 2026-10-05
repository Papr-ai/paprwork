import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  consolidateShadowDir,
  planShadowCleanup,
} from "../src/gateway/services/jobs/consolidateMigrationFolders.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("planShadowCleanup", () => {
  const applied = new Set(["0001_init", "0026_interviews"]);
  const real = new Map([["0001_init.sql", "CREATE TABLE a (id TEXT);"]]);

  it("removes an identical duplicate", () => {
    expect(
      planShadowCleanup({ shadow: [{ name: "0001_init.sql", content: "CREATE TABLE a (id TEXT);\n" }], real, appliedIds: applied }),
    ).toEqual([{ kind: "remove_duplicate", file: "0001_init.sql" }]);
  });

  it("quarantines a copy that differs from the real file (never overwrites it)", () => {
    expect(
      planShadowCleanup({ shadow: [{ name: "0001_init.sql", content: "CREATE TABLE IF NOT EXISTS a (id TEXT);" }], real, appliedIds: applied })[0],
    ).toMatchObject({ kind: "quarantine", reason: "differs from the real file" });
  });

  it("moves an applied file the real folder lacks", () => {
    expect(
      planShadowCleanup({ shadow: [{ name: "0026_interviews.sql", content: "x" }], real, appliedIds: applied }),
    ).toEqual([{ kind: "move_to_real", file: "0026_interviews.sql" }]);
  });

  it("quarantines unapplied files and backups", () => {
    const out = planShadowCleanup({
      shadow: [
        { name: "0030_new.sql", content: "x" },
        { name: "0001_baseline.sql.disabled", content: "x" },
        { name: "0011_a.sql.backup.123", content: "x" },
      ],
      real,
      appliedIds: applied,
    });
    expect(out.every((a) => a.kind === "quarantine")).toBe(true);
  });
});

describe("consolidateShadowDir", () => {
  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "consol-"));
    tmp.push(root);
    const shadowDir = path.join(root, "shadow");
    const realDir = path.join(root, "real");
    fs.mkdirSync(shadowDir);
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, "0001_init.sql"), "A");
    fs.writeFileSync(path.join(shadowDir, "0001_init.sql"), "A");
    fs.writeFileSync(path.join(shadowDir, "0026_interviews.sql"), "B");
    fs.writeFileSync(path.join(shadowDir, "0030_draft.sql"), "C");
    return { shadowDir, realDir };
  }

  it("dry run changes nothing", async () => {
    const { shadowDir, realDir } = setup();
    const r = await consolidateShadowDir({
      shadowDir,
      realDir,
      appliedIds: new Set(["0001_init", "0026_interviews"]),
      dryRun: true,
    });
    expect(r.actions).toHaveLength(3);
    expect(fs.readdirSync(shadowDir)).toHaveLength(3);
    expect(fs.readdirSync(realDir)).toEqual(["0001_init.sql"]);
  });

  it("applies: removes duplicate, moves applied, quarantines unapplied", async () => {
    const { shadowDir, realDir } = setup();
    await consolidateShadowDir({ shadowDir, realDir, appliedIds: new Set(["0001_init", "0026_interviews"]) });
    expect(fs.readdirSync(realDir).sort()).toEqual(["0001_init.sql", "0026_interviews.sql"]);
    expect(fs.readFileSync(path.join(realDir, "0001_init.sql"), "utf8")).toBe("A");
    expect(fs.readdirSync(shadowDir)).toEqual(["_quarantine"]);
    expect(fs.readdirSync(path.join(shadowDir, "_quarantine"))).toEqual(["0030_draft.sql"]);
  });
});
