import { afterEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import { hashBlobContent } from "../src/gateway/services/syncV3/computeParentHash.js";

describe("Sync V3 OID cache + outbox", () => {
  useIsolatedPaprWorkspace("sync-v3-writer-client");

  afterEach(async () => {
    const { clearOidCacheForTests } = await import(
      "../src/gateway/services/syncV3/OidCache.js"
    );
    const { clearSyncOutboxForTests } = await import(
      "../src/gateway/services/syncV3/SyncOutbox.js"
    );
    await clearOidCacheForTests();
    await clearSyncOutboxForTests();
  });

  test("OID cache round-trip", async () => {
    const { applyAckedBlobOids, getCachedBlobOid } = await import(
      "../src/gateway/services/syncV3/OidCache.js"
    );
    await applyAckedBlobOids("app-1", [{ path: "index.html", blobOid: "abc" }]);
    expect(await getCachedBlobOid("app-1", "index.html")).toBe("abc");
  });

  test("outbox append + pending list", async () => {
    const { appendOutboxEntry, listPendingOutboxEntries } = await import(
      "../src/gateway/services/syncV3/SyncOutbox.js"
    );
    await appendOutboxEntry({
      appId: "app-1",
      files: [{ path: "index.html", content: "<html></html>", parentHash: "" }],
      author: "desktop",
      message: "sync",
    });
    const pending = await listPendingOutboxEntries("app-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.files[0]?.path).toBe("index.html");
  });

  test("collectAppOpFiles skips unchanged cached files", async () => {
    const paprDir = process.env.PAPR_HOME!;
    const appId = "writer-test-app";
    const appDir = path.join(paprDir, "apps", appId);
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, "index.html"), "<html></html>", "utf8");

    const content = "<html></html>";
    const oid = hashBlobContent(content);
    const { applyAckedBlobOids } = await import(
      "../src/gateway/services/syncV3/OidCache.js"
    );
    await applyAckedBlobOids(appId, [{ path: "index.html", blobOid: oid }]);

    const { collectAppOpFiles } = await import(
      "../src/gateway/services/syncV3/collectAppOpFiles.js"
    );
    const collected = await collectAppOpFiles(paprDir, appId);
    expect(collected.files).toHaveLength(0);
    expect(collected.skippedUnchanged).toBe(1);
  });
});

describe("writerConfig", () => {
  test("shouldUseWriterOpsPath is always enabled", async () => {
    const { shouldUseWriterOpsPath } = await import(
      "../src/gateway/services/syncV3/writerConfig.js"
    );
    expect(shouldUseWriterOpsPath()).toBe(true);
  });
});
