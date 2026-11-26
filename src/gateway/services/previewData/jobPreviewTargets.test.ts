import { describe, expect, it } from "vitest";
import { applyJobDataTarget, DATA_TARGET_PARAM } from "./jobPreviewTargets.js";
import type { JobWriteDatabaseTarget } from "../jobAppDatabase.js";

const t: JobWriteDatabaseTarget = { dbId: "db-1", alias: "tasks", dbPath: "/real.db", envKey: "TASKS", syncMode: "replica" };
const deps = {
  previewFor: async () => ({ id: "x", type: "sqlite" as const, alias: "tasks", dbPath: "/preview.db", tables: [], linkedAt: "" }),
  proposalFor: async (_a: string, r: string) => ({ id: "x", type: "sqlite" as const, alias: "tasks", dbPath: `/pr-${r}.db`, tables: [], linkedAt: "" }),
};

describe("applyJobDataTarget", () => {
  it("no param, live, or no app: the real data", async () => {
    expect((await applyJobDataTarget([t], "app", undefined, deps)).targets[0]!.dbPath).toBe("/real.db");
    expect((await applyJobDataTarget([t], "app", { [DATA_TARGET_PARAM]: "live" }, deps)).targets[0]!.dbPath).toBe("/real.db");
    expect((await applyJobDataTarget([t], undefined, { [DATA_TARGET_PARAM]: "preview" }, deps)).targets[0]!.dbPath).toBe("/real.db");
  });
  it("preview run writes the test copy as a plain local file (no proxy, no sync)", async () => {
    const r = await applyJobDataTarget([t], "app", { [DATA_TARGET_PARAM]: "preview" }, deps);
    expect(r.targets[0]).toMatchObject({ dbPath: "/preview.db", syncMode: "legacy", dbId: "db-1" });
    expect(r.note).toContain("test copy");
  });
  it("proposal run uses that proposal's copy; no copy keeps real data", async () => {
    expect((await applyJobDataTarget([t], "app", { [DATA_TARGET_PARAM]: "proposal:r9" }, deps)).targets[0]!.dbPath).toBe("/pr-r9.db");
    const none = await applyJobDataTarget([t], "app", { [DATA_TARGET_PARAM]: "preview" }, { ...deps, previewFor: async () => null });
    expect(none).toMatchObject({ targets: [{ dbPath: "/real.db" }], note: null });
  });
});
