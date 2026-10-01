/**
 * Singletons that read app files must follow the active workspace. Both
 * services used to capture the apps root at construction and were never reset
 * on a workspace switch, so after switching, Get updates / Detach / lineage
 * read the previous workspace.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import { serializeCloudAppLineageFile } from "../src/core/utils/cloudAppLineage.js";

const ws = useIsolatedPaprWorkspace("ws-switch");

function writeLineage(appsDir: string, appId: string, slug: string) {
  mkdirSync(join(appsDir, appId), { recursive: true });
  writeFileSync(
    join(appsDir, appId, "papr-cloud-lineage.json"),
    serializeCloudAppLineageFile({
      schemaVersion: "1.2.0",
      lineageId: `lin-${slug}`,
      mode: "track",
      databasePolicy: "forked",
      source: { orgId: "o", namespaceId: "ns", userId: "pub", appId: "src", slug },
      installedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

describe("cloud app services follow the active workspace", () => {
  it("lineage index and detach read the current apps root, not the first one", async () => {
    const { getPaprAppsRoot } = await import("../src/core/utils/paprRoot.js");
    const { getCloudAppLineageService } = await import("../src/gateway/services/CloudAppLineageService.js");
    const { getCloudAppTrackSyncService } = await import("../src/gateway/services/CloudAppTrackSyncService.js");

    const first = getPaprAppsRoot();
    writeLineage(first, "app-a", "first");
    expect(Object.keys((await getCloudAppLineageService().buildIndex()).byAppId)).toEqual(["app-a"]);
    const track = getCloudAppTrackSyncService();

    // Switch: point PAPR_HOME somewhere else (what workspace switch does).
    const second = join(ws.homeDir, "other-ws");
    process.env.PAPR_HOME = second;
    const secondApps = getPaprAppsRoot();
    expect(secondApps).not.toBe(first);
    writeLineage(secondApps, "app-b", "second");

    expect(Object.keys((await getCloudAppLineageService().buildIndex()).byAppId)).toEqual(["app-b"]);
    // Same singleton instance, now acting on the second workspace.
    expect(getCloudAppTrackSyncService()).toBe(track);
    expect(await track.detach("app-b")).toEqual({ detached: true });
    expect(await track.detach("app-a")).toEqual({ detached: false, reason: "not_linked" });
  });
});
