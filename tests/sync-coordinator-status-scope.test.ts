import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import type { CloudSyncService } from "../src/gateway/services/CloudSyncService.js";
import { buildCoordinatorStatusReport } from "../src/gateway/services/cloudSync/coordinatorStatusReport.js";
import { SyncCoordinator } from "../src/gateway/services/cloudSync/SyncCoordinator.js";
import {
  loadTursoSyncState,
  markDbDirty,
  saveTursoSyncState,
} from "../src/gateway/services/tursoSyncState.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

function writeDataSources(
  paprDir: string,
  appId: string,
  dbId: string,
  dbPath: string,
): void {
  const appDir = path.join(paprDir, "apps", appId);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "data-sources.json"),
    JSON.stringify({
      sources: [
        {
          id: dbId,
          type: "sqlite",
          dbId,
          alias: dbId,
          dbPath,
        },
      ],
    }),
  );
}

describe("SyncCoordinator.getStatus app-scoped db dirty keys", () => {
  const workspace = useIsolatedPaprWorkspace("sync-coordinator-scope");

  it("scopes dbDirtySyncKeys to linked sync keys for the requested app", () => {
    const paprDir = workspace.paprHome;
    const otherDir = fs.mkdtempSync(path.join(path.dirname(paprDir), "other-ws-"));
    const dbA = path.join(paprDir, "data", "databases", "a", "data.db");
    const dbB = path.join(paprDir, "data", "databases", "b", "data.db");
    const dbOut = path.join(otherDir, "data", "databases", "out", "data.db");
    fs.mkdirSync(path.dirname(dbA), { recursive: true });
    fs.mkdirSync(path.dirname(dbB), { recursive: true });
    fs.mkdirSync(path.dirname(dbOut), { recursive: true });
    fs.writeFileSync(dbA, "sqlite");
    fs.writeFileSync(dbB, "sqlite");
    fs.writeFileSync(dbOut, "sqlite");

    writeDataSources(paprDir, "app-1", "db-a", dbA);
    writeDataSources(paprDir, "app-2", "db-b", dbB);

    markDbDirty("db-a", dbA, paprDir);
    markDbDirty("db-b", dbB, paprDir);
    saveTursoSyncState(
      {
        jobs: {
          ...loadTursoSyncState(paprDir).jobs,
          "db-out": {
            dbPath: dbOut,
            lastPushAt: new Date(0).toISOString(),
            dirtyFlag: true,
            dirtyFlagAt: new Date().toISOString(),
          },
        },
      },
      paprDir,
    );

    const sync = {
      getPaprDir: () => paprDir,
      enqueueRelativePath: () => undefined,
      hasRelativePathChanged: () => false,
      markRelativePathSynced: () => undefined,
    } as unknown as CloudSyncService;

    const coordinator = new SyncCoordinator(sync);

    expect(coordinator.getStatus("app-1").dbDirtySyncKeys).toEqual(["db-a"]);
    expect(coordinator.getStatus("app-2").dbDirtySyncKeys).toEqual(["db-b"]);
    expect(coordinator.getStatus().dbDirtySyncKeys.sort()).toEqual(["db-a", "db-b"]);

    const app1Report = buildCoordinatorStatusReport(coordinator, "app-1");
    const app2Report = buildCoordinatorStatusReport(coordinator, "app-2");
    expect(app1Report?.status).toBe("waiting");
    expect(app2Report?.status).toBe("waiting");

    fs.rmSync(otherDir, { recursive: true, force: true });
  });
});
