import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

const { uploadAppDbConfigToCloudDirect } = vi.hoisted(() => ({
  uploadAppDbConfigToCloudDirect: vi.fn(),
}));

vi.mock("../src/gateway/services/syncV3/appDbConfigUpload.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/gateway/services/syncV3/appDbConfigUpload.js")
  >();
  return {
    ...actual,
    uploadAppDbConfigToCloudDirect,
  };
});

import {
  clearMetadataOutboxForTests,
  enqueueMetadataOutboxEntry,
  flushMetadataOutbox,
} from "../src/gateway/services/syncV3/metadataOutbox.js";
import { readAppDbConfigFromDisk } from "../src/gateway/services/syncV3/appDbConfigUpload.js";

describe("appDbConfigUpload", () => {
  const workspace = useIsolatedPaprWorkspace("app-db-config");

  afterEach(async () => {
    await clearMetadataOutboxForTests();
    uploadAppDbConfigToCloudDirect.mockReset();
  });

  it("reads data-sources and linked-databases from app dir", async () => {
    const appId = "app-db-test";
    const appDir = path.join(workspace.paprHome, "apps", appId);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "data-sources.json"),
      '{"sources":[{"id":"primary"}]}\n',
    );
    fs.writeFileSync(
      path.join(appDir, "linked-databases.json"),
      '{"databases":{"job-a":{}}}\n',
    );

    const payload = await readAppDbConfigFromDisk(workspace.paprHome, appId);
    expect(payload).not.toBeNull();
    expect(payload?.dataSources).toContain('"primary"');
    expect(payload?.linkedDatabases).toContain("job-a");
  });

  it("flushes queued app db config uploads", async () => {
    uploadAppDbConfigToCloudDirect.mockResolvedValue(true);

    const payload = {
      dataSources: '{"sources":[]}\n',
      linkedDatabases: '{"databases":{}}\n',
      updatedAt: "2026-08-21T00:00:00.000Z",
      commitSha: "sha123",
    };

    await enqueueMetadataOutboxEntry({
      kind: "app-db-config",
      updatedAt: payload.updatedAt,
      appId: "app-1",
      appDbConfig: payload,
    });

    const result = await flushMetadataOutbox();
    expect(result.flushed).toBe(1);
    expect(uploadAppDbConfigToCloudDirect).toHaveBeenCalledWith("app-1", payload);
  });
});
