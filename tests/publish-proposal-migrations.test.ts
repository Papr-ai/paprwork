import { describe, expect, it } from "vitest";
import {
  proposalMigrationsFromWrites,
  publishProposalMigrations,
  type PublishMigrationsDeps,
} from "../src/gateway/services/cloudSync/publishProposalMigrations.js";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";

const source = { id: "s", type: "sqlite", dbId: "db-1", alias: "a", dbPath: "/x/data.db", tables: [], linkedAt: "" } as AppDataSource;

function deps(over: Partial<PublishMigrationsDeps> = {}, log: string[] = []): PublishMigrationsDeps {
  return {
    checkAllowed: async () => (log.push("check"), { allowed: true }),
    resolveTarget: () => ({ tursoDatabase: "d-1", source }),
    online: () => true,
    pushPending: async () => (log.push("push"), { ok: true }),
    applyOnCloud: async (_db, _root, id) => (log.push(`apply:${id}`), true),
    verifyOnCloud: async (_db, _root, id) => (log.push(`verify:${id}`), true),
    pull: async () => void log.push("pull"),
    ...over,
  };
}

const m = (id: string) => ({ dbId: "db-1", migrationRoot: "/root", migrationId: id });

describe("publishProposalMigrations", () => {
  it("checks, uploads pending rows, migrates in order, verifies, then pulls", async () => {
    const log: string[] = [];
    const r = await publishProposalMigrations([m("0019_b"), m("0018_a")], deps({}, log));
    expect(r).toEqual({ published: true, migrated: ["0018_a", "0019_b"] });
    expect(log).toEqual(["check", "push", "apply:0018_a", "verify:0018_a", "apply:0019_b", "verify:0019_b", "pull"]);
  });

  it("touches nothing when the server would not allow the publish", async () => {
    const log: string[] = [];
    const r = await publishProposalMigrations(
      [m("0018_a")],
      deps({ checkAllowed: async () => (log.push("check"), { allowed: false, reason: "needs review" }) }, log),
    );
    expect(r).toEqual({ published: false, migrated: [], reason: "needs review" });
    expect(log).toEqual(["check"]);
  });

  it("sends own-data or per-user copies to review without asking the server", async () => {
    const log: string[] = [];
    const r = await publishProposalMigrations([m("0018_a")], deps({ resolveTarget: () => ({ reason: "own data" }) }, log));
    expect(r.published).toBe(false);
    expect(r.reason).toBe("own data");
    expect(log).toEqual([]);
  });

  it("goes to review when offline", async () => {
    const r = await publishProposalMigrations([m("0018_a")], deps({ online: () => false }));
    expect(r.published).toBe(false);
  });

  it("stops (no submit) when the cloud schema does not verify", async () => {
    await expect(
      publishProposalMigrations([m("0018_a")], deps({ verifyOnCloud: async () => false })),
    ).rejects.toThrow(/didn't verify/);
  });

  it("stops before migrating when pending rows can't be uploaded", async () => {
    const log: string[] = [];
    await expect(
      publishProposalMigrations([m("0018_a")], deps({ pushPending: async () => ({ ok: false, error: "x" }) }, log)),
    ).rejects.toThrow(/pending rows/);
    expect(log).toEqual(["check"]);
  });

  it("sends to review when the kill switch is off", async () => {
    process.env.PAPR_PROPOSAL_DB_PUBLISH = "0";
    try {
      const log: string[] = [];
      const r = await publishProposalMigrations([m("0018_a")], deps({}, log));
      expect(r.published).toBe(false);
      expect(log).toEqual([]);
    } finally {
      delete process.env.PAPR_PROPOSAL_DB_PUBLISH;
    }
  });

  it("is a no-op with no migrations", async () => {
    const log: string[] = [];
    expect(await publishProposalMigrations([], deps({}, log))).toEqual({ published: true, migrated: [] });
    expect(log).toEqual([]);
  });
});

describe("proposalMigrationsFromWrites", () => {
  it("picks only new .sql files directly in a database migrations tree", () => {
    const dir = ["databases", "studio", "migrations"].join("/");
    const out = proposalMigrationsFromWrites(
      [`${dir}/0018_a.sql`, `${dir}/snapshot.json`, `${dir}/sub/x.sql`, "app.ts"],
      [
        { repoRelativeDir: dir, dbId: "db-1", migrationRoot: "/root" },
        { repoRelativeDir: "apps/x" },
      ],
    );
    expect(out).toEqual([{ dbId: "db-1", migrationRoot: "/root", migrationId: "0018_a" }]);
  });
});
