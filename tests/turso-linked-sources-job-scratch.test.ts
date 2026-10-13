import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { discoverTursoLinkedSources } from "../src/gateway/services/tursoLinkedSources.js";
import { resolveTursoBookendTargets } from "../src/gateway/services/cloudAgentGateway/cloudAgentRunContext.js";

describe("job scratch DBs never sync to Turso", () => {
  it("discoverTursoLinkedSources skips legacy links to Jobs/{id}/data/data.db", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-scratch-"));
    process.env.PAPR_HOME = root;
    const jobDb = path.join(root, "Jobs", "job-1", "data", "data.db");
    const regDb = path.join(root, "data", "databases", "briefs", "data.db");
    for (const f of [jobDb, regDb]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "");
    }
    const appDir = path.join(root, "apps", "app-1");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "data-sources.json"), JSON.stringify({
      sources: [
        { id: "s1", type: "sqlite", jobId: "job-1", alias: "legacy", dbPath: jobDb, tables: [], linkedAt: "x" },
        { id: "s2", type: "sqlite", dbId: "db-1", alias: "reg", dbPath: regDb, tables: [], linkedAt: "x" },
      ],
    }));
    const sources = await discoverTursoLinkedSources(path.join(root, "apps"));
    expect(sources.some((s) => s.dbPath.includes(`${path.sep}Jobs${path.sep}`))).toBe(false);
  });

  it("cloud run bookends drop job-scratch targets and legacy request.turso", () => {
    const targets = resolveTursoBookendTargets({
      jobId: "job-1",
      turso: { jobId: "job-1", databaseUrl: "libsql://x", authToken: "t" },
      tursoSources: [
        { syncKey: "job-1", dbPath: "/h/Jobs/job-1/data/data.db", databaseUrl: "libsql://x", authToken: "t" },
        { syncKey: "db-1", dbPath: "/h/data/databases/briefs/data.db", databaseUrl: "libsql://y", authToken: "t" },
      ],
    } as never, "/h");
    expect(targets.map((t) => t.syncKey)).toEqual(["db-1"]);
  });
});
