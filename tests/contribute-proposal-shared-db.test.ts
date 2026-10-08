/**
 * Proposals must not rewrite the publisher's database records (2026-10-07 Customer Contacts PR shipped
 * data/databases.json naming the contributor's copy as schema owner, plus two
 * failed trigger migrations).
 */
import { describe, expect, it } from "vitest";

import { mergeDatabasesJsonForContribute } from "../src/gateway/services/cloudSync/contributeDataIndexMerge.js";

const rec = (dbId: string, owner: string, extra: object = {}) => ({
  dbId, localPath: "/x/data.db", tursoShortName: `d-${dbId.slice(3)}`, isolation: "shared" as const,
  status: "active" as const, schemaOwnerAppId: owner, createdAt: "t", updatedAt: "t", ...extra,
});

describe("mergeDatabasesJsonForContribute", () => {
  it("never rewrites a database the publisher already has", () => {
    const owner = { version: 1 as const, databases: { "db-f3115d59": rec("db-f3115d59", "publisher") } };
    const contributor = {
      version: 1 as const,
      databases: { "db-f3115d59": rec("db-f3115d59", "copy", { syncMode: "replica" }) },
    };
    const merged = mergeDatabasesJsonForContribute(owner, contributor, ["db-f3115d59"], {
      forkAppId: "copy", targetAppId: "publisher",
    });
    expect(merged.databases["db-f3115d59"]).toEqual(owner.databases["db-f3115d59"]);
  });

  it("a new database is added, owned by the publisher's app, with no local path", () => {
    const owner = { version: 1 as const, databases: {} };
    const contributor = { version: 1 as const, databases: { "db-0000aaaa": rec("db-0000aaaa", "copy") } };
    const merged = mergeDatabasesJsonForContribute(owner, contributor, ["db-0000aaaa"], {
      forkAppId: "copy", targetAppId: "publisher",
    });
    expect(merged.databases["db-0000aaaa"]).toMatchObject({ schemaOwnerAppId: "publisher", localPath: "" });
  });
});
