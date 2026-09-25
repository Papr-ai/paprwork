import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

let appsRoot = "";
vi.mock("../src/core/utils/paprRoot.js", async (orig) => ({
  ...(await orig<object>()),
  getPaprAppsRoot: () => appsRoot,
}));
vi.mock("../src/gateway/services/cloudSync/trackUpstreamRevision.js", () => ({
  fetchPublishedAppRevision: vi.fn().mockResolvedValue("d94ca5b7986eae8d"),
}));
vi.mock("../src/gateway/services/appRuntime/cloudPreviewRuntimeAuth.js", () => ({
  buildCloudPreviewAuthHeaders: vi.fn().mockResolvedValue({}),
}));

import { checkPublisherUpstreamRevision } from "../src/gateway/services/syncV3/checkPublisherUpstreamRevision.js";

async function writeLineage(appId: string, lineage: Record<string, unknown>) {
  await fs.mkdir(path.join(appsRoot, appId), { recursive: true });
  await fs.writeFile(
    path.join(appsRoot, appId, "papr-cloud-lineage.json"),
    JSON.stringify({
      schemaVersion: "1.2.0",
      lineageId: "l1",
      source: { orgId: "o", namespaceId: "ns", userId: "u", appId: "src", slug: "demo" },
      installedAt: "2026-09-23T00:00:00Z",
      ...lineage,
    }),
  );
}

describe("checkPublisherUpstreamRevision", () => {
  beforeEach(async () => {
    appsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "papr-upstream-"));
  });
  afterEach(async () => {
    await fs.rm(appsRoot, { recursive: true, force: true });
  });

  it("plain fork is never behind the publisher", async () => {
    await writeLineage("a1", { mode: "fork" });
    const r = await checkPublisherUpstreamRevision("a1");
    expect(r.publisherUpdatesAvailable).toBe(false);
  });

  it("collaborator without stored revision uses the snapshot's dist hash (no false update)", async () => {
    await writeLineage("a2", {
      mode: "track",
      syncSnapshot: { "dist/app.js": "d94ca5b7986eae8d23c0cb51b1e27b509c443fd3d932f5925bb0f55d2deb553f" },
    });
    const r = await checkPublisherUpstreamRevision("a2");
    expect(r.publisherUpdatesAvailable).toBe(false);
  });

  it("collaborator is behind when the publisher's bundle changed", async () => {
    await writeLineage("a3", {
      mode: "track",
      syncSnapshot: { "dist/app.js": "0000000000000000aaaa" },
    });
    const r = await checkPublisherUpstreamRevision("a3");
    expect(r.publisherUpdatesAvailable).toBe(true);
  });
});
