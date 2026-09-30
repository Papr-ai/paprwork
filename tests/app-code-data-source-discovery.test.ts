import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { scanAppCodeForJobDatabaseReferences } from "../src/gateway/services/appCodeDataSourceDiscovery.js";

describe("appCodeDataSourceDiscovery", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-db-discover-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("finds job databases from /api/db/query jobId and dist bundles", async () => {
    const jobId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const appDir = path.join(tempDir, "apps", "my-app");
    const jobsRoot = path.join(tempDir, "Jobs");

    await fs.mkdir(path.join(appDir, "dist"), { recursive: true });
    await fs.mkdir(path.join(jobsRoot, jobId, "data"), { recursive: true });
    await fs.writeFile(path.join(jobsRoot, jobId, "data", "data.db"), "db", "utf8");
    await fs.writeFile(
      path.join(appDir, "dist", "app.js"),
      `
        fetch('/api/db/query', {
          method: 'POST',
          body: JSON.stringify({ jobId: '${jobId}', sql: 'SELECT 1' }),
        });
      `,
      "utf8",
    );

    const refs = await scanAppCodeForJobDatabaseReferences({ appDir, jobsRoot });
    expect(refs).toHaveLength(1);
    expect(refs[0]?.jobId).toBe(jobId);
    expect(refs[0]?.matchedBy).toBe("api_db");
  });

  it("finds explicit Papr job db paths in source files", async () => {
    const jobId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const appDir = path.join(tempDir, "apps", "other-app");
    const jobsRoot = path.join(tempDir, "Jobs");

    await fs.mkdir(appDir, { recursive: true });
    await fs.mkdir(path.join(jobsRoot, jobId, "data"), { recursive: true });
    await fs.writeFile(path.join(jobsRoot, jobId, "data", "data.db"), "db", "utf8");
    await fs.writeFile(
      path.join(appDir, "index.html"),
      `<script>
        const db = '$PAPR_HOME/Jobs/${jobId}/data/data.db';
      </script>`,
      "utf8",
    );

    const refs = await scanAppCodeForJobDatabaseReferences({ appDir, jobsRoot });
    expect(refs.some((ref) => ref.jobId === jobId)).toBe(true);
  });
});
