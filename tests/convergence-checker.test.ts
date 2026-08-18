import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadConvergenceState,
  loadConvergenceStateForApp,
  markConvergenceVerifiedForLinkedSource,
  saveConvergenceState,
} from "../src/gateway/services/cloudSync/convergenceChecker.js";
import type { TursoLinkedSource } from "../src/gateway/services/tursoLinkedSources.js";

describe("convergenceChecker state", () => {
  it("markConvergenceVerifiedForLinkedSource clears cached driftTables", () => {
    const paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-conv-"));
    const linked: TursoLinkedSource = {
      appId: "app-home",
      jobId: "2cafb2e9-696b-42db-98fa-5d605977123c",
      dbPath: path.join(paprDir, "Jobs", "2cafb2e9", "data", "data.db"),
      alias: "Daily Brief",
    };

    saveConvergenceState(
      {
        sources: {
          "2cafb2e9-696b-42db-98fa-5d605977123c": {
            syncKey: "2cafb2e9-696b-42db-98fa-5d605977123c",
            appId: "app-home",
            alias: "Daily Brief",
            lastCheckedAt: "2026-08-17T19:00:00.000Z",
            lastVerifiedAt: null,
            ok: false,
            driftTables: ["briefs", "decisions", "evidence"],
          },
        },
      },
      paprDir,
    );

    markConvergenceVerifiedForLinkedSource(linked, paprDir);

    const state = loadConvergenceState(paprDir);
    const entry = state.sources["2cafb2e9-696b-42db-98fa-5d605977123c"];
    expect(entry?.ok).toBe(true);
    expect(entry?.driftTables).toEqual([]);
    expect(entry?.lastVerifiedAt).toBeTruthy();

    const appState = loadConvergenceStateForApp("app-home", paprDir);
    expect(appState?.ok).toBe(true);
    expect(appState?.driftTables).toEqual([]);
  });
});
