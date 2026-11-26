/**
 * ensureAppDbTs must not regenerate db.ts when the app imports names the
 * generated file would drop.
 *
 * Before: validate_app ran ensureAppDbTs on every app. Any db.ts that differed
 * from the generated template was overwritten — including hand-added helpers
 * (esc, runJob, splitList) and the old generator's APP_ID / SOURCE_ID. Reddit
 * Research Agent and SEO Audit stopped building ("No matching export in db.ts
 * for import esc"), and kept working only off a stale dist/ bundle.
 */
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildAppDbTsContent,
  exportedNames,
  namesImportedFromDb,
} from "../../src/gateway/services/appDataSources.js";

const roots: string[] = [];
const envBefore = { HOME: process.env.HOME, PAPR_HOME: process.env.PAPR_HOME, PAPR_USER_DATA: process.env.PAPR_USER_DATA };

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
});

const CUSTOM_DB_TS = `export const SOURCE_ID = "research";
export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> { return []; }
export function esc(s: unknown): string { return String(s ?? ""); }
export async function runJob(jobId: string): Promise<void> {}
`;

async function appWith(dbTs: string, appTs: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-dbts-"));
  roots.push(root);
  process.env.HOME = root;
  process.env.PAPR_HOME = path.join(root, "Papr");
  process.env.PAPR_USER_DATA = path.join(root, ".paprwork-v2");
  await fs.mkdir(process.env.PAPR_HOME, { recursive: true });
  const dbDir = path.join(process.env.PAPR_HOME, "data", "databases", "research");
  await fs.mkdir(dbDir, { recursive: true });
  await fs.writeFile(path.join(dbDir, "data.db"), "");
  vi.resetModules();
  const { AppService } = await import("../../src/gateway/services/AppService.js");
  const service = new AppService();
  await service.initialize();
  const app = await service.createApp("Research", "x", [
    { filename: "index.html", content: "<div></div>" },
    { filename: "app.ts", content: appTs },
    { filename: "db.ts", content: dbTs },
    {
      filename: "data-sources.json",
      content: JSON.stringify({
        sources: [{ id: "x:research", type: "sqlite", alias: "research", dbPath: path.join(dbDir, "data.db"), tables: [] }],
      }),
    },
  ]);
  const dbTsPath = path.join(process.env.PAPR_HOME, "apps", app.id, "db.ts");
  // createApp may scaffold; put the author's file back exactly.
  await fs.writeFile(dbTsPath, dbTs, "utf8");
  return { service, appId: app.id, dbTsPath };
}

describe("db.ts import scanning", () => {
  test("finds names imported from ./db in its forms", () => {
    expect(namesImportedFromDb(`import { esc, runJob as run } from './db';`)).toEqual(["esc", "runJob"]);
    expect(namesImportedFromDb(`import { query, APP_ID } from "./db.ts"`)).toEqual(["query", "APP_ID"]);
    expect(namesImportedFromDb(`import { type Row } from '../db'`)).toEqual(["Row"]);
    expect(namesImportedFromDb(`import { x } from './dbx'`)).toEqual([]);
  });

  test("generated db.ts exports query/exec/DB_SOURCES", () => {
    const names = exportedNames(buildAppDbTsContent([{ alias: "research" }]));
    expect([...names].sort()).toEqual(["DB_SOURCES", "DbSourceId", "exec", "query"]);
  });
});

describe("ensureAppDbTs", () => {
  test("keeps a db.ts whose custom exports the app imports", async () => {
    const { service, appId, dbTsPath } = await appWith(
      CUSTOM_DB_TS,
      `import { query, esc, runJob } from './db';\nexport const x = [query, esc, runJob];\n`,
    );
    await service.ensureAppDbTs(appId);
    expect(await fs.readFile(dbTsPath, "utf8")).toBe(CUSTOM_DB_TS);
  }, 90_000);

  test("still refreshes db.ts when the app only uses generated names", async () => {
    const { service, appId, dbTsPath } = await appWith(
      CUSTOM_DB_TS,
      `import { query } from './db';\nexport const x = query;\n`,
    );
    await service.ensureAppDbTs(appId);
    expect(await fs.readFile(dbTsPath, "utf8")).toBe(buildAppDbTsContent([{ alias: "research" }]));
  }, 90_000);
});
