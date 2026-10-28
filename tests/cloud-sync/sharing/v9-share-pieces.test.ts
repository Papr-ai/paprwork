/** v9: data check scopes, Write with AI prompt/parse, "Published by" line. */
import { describe, expect, it } from "vitest";

import {
  scopeTables,
  scopeTag,
  tableIsShared,
  tableScope,
} from "../../../src/core/utils/tableScope.js";
import {
  buildDraftPrompt,
  compactFileDiff,
  parseDraft,
} from "../../../src/gateway/services/cloudSync/proposalDraft.js";
import { formatMergeByline } from "../../../ui/utils/mergeByline.js";

const cols = (...names: string[]) => names.map((name) => ({ name }));

describe("table scope", () => {
  it("reads owner columns", () => {
    expect(tableScope(cols("id", "papr_user_id"))).toBe("user");
    expect(tableScope(cols("id", "owner_session"))).toBe("visitor");
    expect(tableScope(cols("id", "name"))).toBe("all");
    expect(tableScope(cols("id"), true)).toBe("user");
  });

  it("visitor tables only leak without sign-in; internal tables skipped", () => {
    const t = scopeTables([
      {
        alias: "crm",
        tables: [
          { table: "leads", columns: cols("id") },
          { table: "signups", columns: cols("owner_session") },
          { table: "sqlite_sequence", columns: cols("name") },
          { table: "_papr_migrations", columns: cols("id") },
        ],
      },
    ]);
    expect(t.map((x) => x.name)).toEqual(["leads", "signups"]);
    expect(t.filter((x) => tableIsShared(x, false)).length).toBe(2);
    expect(t.filter((x) => tableIsShared(x, true)).map((x) => x.name)).toEqual(["leads"]);
    expect(scopeTag(t[1]!, false)).toBe("Needs sign-in");
    expect(scopeTag(t[1]!, true)).toBe("Per person");
  });
});

describe("table scope: private tables and engine bookkeeping", () => {
  const cols = (...n: string[]) => n.map((name) => ({ name }));
  it("tables marked private on the database are not visible to visitors", () => {
    const t = scopeTables([{ alias: "docs", privateTables: ["Docs", "doc_blocks"], tables: [
      { table: "docs", columns: cols("id", "_acl") },
      { table: "doc_blocks", columns: cols("id") },
      { table: "catalog", columns: cols("id") },
    ] }]);
    expect(t.map((x) => [x.name, x.scope])).toEqual([["docs", "private"], ["doc_blocks", "private"], ["catalog", "all"]]);
    expect(t.filter((x) => tableIsShared(x, false)).map((x) => x.name)).toEqual(["catalog"]);
    expect(scopeTag(t[0], false)).toBe("Private");
  });
  it("never lists sync, CDC or migration bookkeeping as app data", () => {
    const t = scopeTables([{ alias: "docs", tables: ["turso_cdc", "turso_cdc_version", "turso_sync_last_change_id", "schema_migrations", "libsql_wasm_func_table", "notes"]
      .map((table) => ({ table, columns: cols("id") })) }]);
    expect(t.map((x) => x.name)).toEqual(["notes"]);
  });
});

describe("Write with AI", () => {
  it("keeps only the changed middle of a file", () => {
    const d = compactFileDiff({ path: "app.ts", before: "a\nb\nc\nd", after: "a\nB\nc\nd" });
    expect(d).toBe("Edited app.ts (line 2)\n- b\n+ B");
    expect(compactFileDiff({ path: "x.ts", before: undefined, after: "hi" })).toContain("New file x.ts");
    expect(compactFileDiff({ path: "y.ts", before: "z", after: undefined })).toBe("Removed file y.ts");
  });

  it("caps the prompt and parses the reply", () => {
    const big = "x\n".repeat(20_000);
    const p = buildDraftPrompt("CRM", [
      { path: "a.ts", before: "", after: big },
      { path: "b.ts", before: "", after: big },
      { path: "c.ts", before: "", after: big },
      { path: "d.ts", before: "", after: big },
      { path: "e.ts", before: "", after: big },
      { path: "f.ts", before: "", after: big },
    ]);
    expect(p.length).toBeLessThan(16_000);
    expect(p).toContain("more file(s)");
    expect(parseDraft("TITLE: Fix chart labels.\nSUMMARY: Labels no longer overlap.")).toEqual({
      title: "Fix chart labels",
      description: "Labels no longer overlap.",
    });
    expect(parseDraft("nothing useful")).toBeNull();
  });
});

describe("Published by", () => {
  it("names the Maintainer and the change", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    const line = formatMergeByline(
      { actorUserId: "u2", title: "Fix chart labels", publishedDirectly: true, at: "2026-10-12T10:00:00Z" },
      [{ userId: "u2", displayName: "Shawkat" }],
      now,
    );
    expect(line).toBe("Published by Shawkat · “Fix chart labels” · 2h ago");
    expect(
      formatMergeByline({ actorUserId: "zz", title: null, publishedDirectly: false, at: "2026-10-12T11:59:50Z" }, [], now),
    ).toBe("Accepted by a Maintainer · just now");
  });
});
