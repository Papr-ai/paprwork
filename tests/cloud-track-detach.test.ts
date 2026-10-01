import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { serializeCloudAppLineageFile, parseCloudAppLineageFile } from "../src/core/utils/cloudAppLineage.js";
import type { CloudAppLineageFile } from "../src/core/types/cloudAppLineage.js";
import { CLOUD_LINEAGE_FILENAME } from "../src/gateway/services/CloudAppLineageService.js";
import { CloudAppTrackSyncService } from "../src/gateway/services/CloudAppTrackSyncService.js";
import { copyAxesFromLineage } from "../src/core/utils/copyAxes.js";

const lineage = (o: Partial<CloudAppLineageFile> = {}): CloudAppLineageFile => ({
  schemaVersion: "1.2.0",
  lineageId: "l-1",
  mode: "track",
  source: { orgId: "o", namespaceId: "ns", userId: "u", appId: "src", slug: "papr-doctor" },
  installedAt: "2026-09-01T00:00:00.000Z",
  ...o,
});

describe("v5 Detach", () => {
  let appsDir = "";
  const write = (l: CloudAppLineageFile) => {
    mkdirSync(join(appsDir, "app-1"), { recursive: true });
    writeFileSync(join(appsDir, "app-1", CLOUD_LINEAGE_FILENAME), serializeCloudAppLineageFile(l));
  };
  const read = () =>
    parseCloudAppLineageFile(readFileSync(join(appsDir, "app-1", CLOUD_LINEAGE_FILENAME), "utf8"))!;

  beforeEach(() => {
    appsDir = mkdtempSync(join(tmpdir(), "detach-"));
  });
  afterEach(() => rmSync(appsDir, { recursive: true, force: true }));

  it("detaches a linked copy on its own data, and it stays detached", async () => {
    write(lineage({ databasePolicy: "forked", sourceAudience: "community", trackAutoPull: true }));
    const result = await new CloudAppTrackSyncService(appsDir).detach("app-1");
    expect(result).toEqual({ detached: true });
    const after = read();
    expect(after.mode).toBe("fork");
    expect(after.trackAutoPull).toBe(false);
    expect(after.databasePolicy).toBe("forked");
    expect(copyAxesFromLineage(after)).toMatchObject({ link: "detached", dataMode: "own" });
    // Source kept for credit (fork mark), not for updates.
    expect(after.source.slug).toBe("papr-doctor");
  });

  it("refuses a copy on the team's live data", async () => {
    write(lineage({ databasePolicy: "shared", sourceAudience: "team" }));
    const result = await new CloudAppTrackSyncService(appsDir).detach("app-1");
    expect(result).toEqual({ detached: false, reason: "on_team_data" });
    expect(read().mode).toBe("track");
  });

  it("allows a team copy on its own data", async () => {
    write(lineage({ databasePolicy: "forked", sourceAudience: "team" }));
    expect(await new CloudAppTrackSyncService(appsDir).detach("app-1")).toEqual({ detached: true });
  });

  it("refuses an older track install with no databasePolicy (it is on shared data)", async () => {
    write(lineage({}));
    expect(await new CloudAppTrackSyncService(appsDir).detach("app-1")).toEqual({ detached: false, reason: "on_team_data" });
  });

  it("is a no-op for an app that isn't linked", async () => {
    write(lineage({ mode: "fork", databasePolicy: "forked" }));
    expect(await new CloudAppTrackSyncService(appsDir).detach("app-1")).toEqual({ detached: false, reason: "not_linked" });
  });
});
