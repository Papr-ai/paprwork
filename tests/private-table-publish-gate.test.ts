import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as priv from "../src/gateway/services/appPrivateTables.js";
import {
  assertPrivateTablesPublishable,
  checkPrivateTablesForPublish,
  describeViolation,
  PrivateTablePublishError,
} from "../src/gateway/services/privateTablePublishGate.js";
import { buildUploadFailureAgentPrompt } from "../ui/utils/openCloudSyncAgentChat.js";

function app(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "papr-gate-"));
  for (const [rel, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), c);
  }
  return root;
}
const withPrivate = (t: string[]) =>
  vi.spyOn(priv, "resolveAppPrivateTables").mockResolvedValue({ tables: new Set(t), byDb: new Map() });

describe("private table publish gate", () => {
  let dir = "";
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("passes when nothing is private (default)", async () => {
    dir = app({ "app.ts": "await dbQuery(`SELECT * FROM notes`)" });
    withPrivate([]);
    await expect(assertPrivateTablesPublishable(dir)).resolves.toBeUndefined();
  });

  it("blocks frontend use with a structured error and a plain first line", async () => {
    dir = app({ "app.ts": "x\nawait dbQuery(`SELECT * FROM notes`)" });
    withPrivate(["notes"]);
    const err = await assertPrivateTablesPublishable(dir).catch((e) => e);
    expect(err).toBeInstanceOf(PrivateTablePublishError);
    expect(err.code).toBe("private_table_violation");
    expect(err.detail.tables).toEqual([{ table: "notes", rule: "table-acl-frontend", sites: ["app.ts:2"] }]);
    const first = String(err.message).split("\n")[0];
    expect(first).toBe(err.detail.message);
    expect(first.length).toBeLessThanOrEqual(120);
    expect(err.message).toContain("app.ts:2");
  });

  it("blocks unfiltered backend reads; passes once filtered", async () => {
    dir = app({ "backend/list.py": 'query(con, "SELECT * FROM notes")' });
    withPrivate(["notes"]);
    expect((await checkPrivateTablesForPublish(dir))?.tables[0]?.rule).toBe("table-acl-unfiltered");
    writeFileSync(path.join(dir, "backend/list.py"), 'w,a=acl_read_filter()\nquery(con, f"SELECT * FROM notes WHERE {w}", a)');
    expect(await checkPrivateTablesForPublish(dir)).toBeNull();
  });

  it("messages stay short for many tables", () => {
    const msg = describeViolation([
      { table: "a", rule: "table-acl-unfiltered", sites: [] },
      { table: "b", rule: "table-acl-unfiltered", sites: [] },
    ]);
    expect(msg).toMatch(/^"a", "b" are private/);
  });

  it("Ask agent prompt explains the fix and the keep-public option", async () => {
    dir = app({ "app.ts": "await dbQuery(`SELECT * FROM notes`)" });
    withPrivate(["notes"]);
    const err = await assertPrivateTablesPublishable(dir).catch((e) => e);
    const prompt = buildUploadFailureAgentPrompt({ appId: "a1", error: err.message });
    expect(prompt).toContain("app.ts:1");
    expect(prompt).toContain("acl_read_filter");
    expect(prompt).toContain("papr_db_set_table_access");
    expect(prompt).not.toContain("repair_cloud_sync");
  });
});
