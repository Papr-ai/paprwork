/**
 * Regression for the v2.7.6 review of #705: a proposal whose only changes are
 * in a linked Jobs/{id} folder or an unapplied migration has no app-folder
 * edits, so the old early "No changes to contribute" check refused it before
 * the server was ever asked. propose() must reach prepare in both cases;
 * emptiness is decided over the full change set at the push step.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let appsRoot = "";
const cloudApiFetch = vi.fn();
const localEdits = vi.fn();

vi.mock("../../../src/core/utils/paprRoot.js", () => ({
  getPaprAppsRoot: () => appsRoot,
  getPaprRoot: () => path.dirname(appsRoot),
}));
vi.mock("../../../src/gateway/utils/cloudApiClient.js", () => ({
  cloudApiFetch: (...args: unknown[]) => cloudApiFetch(...args),
}));
vi.mock("../../../src/gateway/services/CloudAppTrackSyncService.js", () => ({
  getCloudAppTrackSyncService: () => ({ localEdits }),
  isCollaboratorEditablePath: () => true,
}));
vi.mock("../../../src/gateway/utils/paprUserId.js", () => ({
  getPaprCallerIdentity: () => ({ userId: "u1" }),
}));

const { getCloudAppContributeService } = await import(
  "../../../src/gateway/services/CloudAppContributeService.js"
);

const APP_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(async () => {
  appsRoot = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "contrib-empty-")), "apps");
  await fs.mkdir(path.join(appsRoot, APP_ID), { recursive: true });
  await fs.writeFile(
    path.join(appsRoot, APP_ID, "papr-cloud-lineage.json"),
    JSON.stringify({ lineageId: "lin-1" }),
  );
  // App folder matches the publisher: no app-file edits.
  localEdits.mockResolvedValue({ known: true, files: [] });
  // Stop right after prepare: we only care that propose() got this far.
  cloudApiFetch.mockResolvedValue(new Response("stop here", { status: 503 }));
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(path.dirname(appsRoot), { recursive: true, force: true });
});

const propose = () =>
  getCloudAppContributeService().propose({
    installedAppId: APP_ID,
    sourceNamespaceId: "ns",
    sourceSlug: "slug",
    title: "t",
    description: "d",
  } as never);

describe("propose() with no app-folder edits", () => {
  it("job-only proposal (edits only in a linked Jobs/{id}) reaches prepare", async () => {
    await expect(propose()).rejects.toThrow(/Prepare contribute failed \(503\)/);
    expect(cloudApiFetch).toHaveBeenCalledWith(
      "/v1/cloud/apps/changes/prepare",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("migration-only proposal (papr_db_create_migration apply:false) reaches prepare", async () => {
    await expect(propose()).rejects.not.toThrow(/No changes to contribute/);
    expect(cloudApiFetch.mock.calls[0]?.[0]).toBe("/v1/cloud/apps/changes/prepare");
  });

  it("no longer consults app-folder edits to decide emptiness", async () => {
    await propose().catch(() => {});
    expect(localEdits).not.toHaveBeenCalled();
  });
});

describe("push step decides emptiness over the full change set", () => {
  const app = (local: Record<string, string>, base: Record<string, string>) => ({
    repoDir: "apps/x",
    local: new Map(Object.entries(local)),
    base: new Map(Object.entries(base)),
    kind: "app" as const,
  });
  const same = { "index.html": "<p>hi</p>", "app.ts": "export {};" };

  it("job-only: app unchanged, linked Jobs/{id} edited → the job file is written", async () => {
    const { buildProposalChangeSet } = await import(
      "../../../src/gateway/services/cloudSync/contributeChangeSet.js"
    );
    const changes = buildProposalChangeSet([
      app(same, same),
      { repoDir: "jobs/j1", local: new Map([["main.py", "print(2)"]]), base: new Map([["main.py", "print(1)"]]), kind: "job" },
    ]);
    expect([...changes.writes.keys()]).toEqual(["jobs/j1/main.py"]);
    expect(changes.deletes).toEqual([]);
  });

  it("migration-only: app unchanged, new held migration → the .sql is written and allowed", async () => {
    const { buildProposalChangeSet } = await import(
      "../../../src/gateway/services/cloudSync/contributeChangeSet.js"
    );
    const changes = buildProposalChangeSet([
      app(same, same),
      {
        repoDir: "databases/db1/migrations",
        local: new Map([["0001_init.sql", "create table a(x);"], ["0002_add_b.sql", "alter table a add b;"]]),
        base: new Map([["0001_init.sql", "create table a(x);"]]),
        kind: "migrations",
        appliedIds: new Set(["0001_init", "0002_add_b"]),
      },
    ]);
    expect([...changes.writes.keys()]).toEqual(["databases/db1/migrations/0002_add_b.sql"]);
    expect(changes.unapplied).toEqual([]);
  });

  it("truly empty: nothing changed anywhere → no writes, so the push step refuses it", async () => {
    const { buildProposalChangeSet } = await import(
      "../../../src/gateway/services/cloudSync/contributeChangeSet.js"
    );
    const changes = buildProposalChangeSet([app(same, same)]);
    expect(changes.writes.size).toBe(0);
    expect(changes.deletes).toEqual([]);
  });
});
