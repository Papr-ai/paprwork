import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { remapForkJobIds } from "../src/gateway/services/cloudAppLinkedResourcesInstall.js";

describe("remapForkJobIds", () => {
  let root: string;
  const publisherAppId = randomUUID();
  const jobId = randomUUID();

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-fork-jobs-"));
    const repo = path.join(root, "repo");
    await fs.mkdir(path.join(repo, "Jobs", jobId, "code"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "Jobs", jobId, "job.json"),
      JSON.stringify({ id: jobId, appIds: [publisherAppId] }),
    );
    await fs.mkdir(path.join(repo, "data"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "data", "jobs.json"),
      JSON.stringify({ jobs: [{ id: jobId, appIds: [publisherAppId] }] }),
    );
    await fs.mkdir(path.join(root, "local"), { recursive: true });
    await fs.writeFile(
      path.join(root, "local", "app.ts"),
      `fetch("/api/jobs/run", { body: JSON.stringify({ jobId: "${jobId}" }) });`,
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("gives every linked job a new id in folders, job.json, jobs.json and app code", async () => {
    const remap = await remapForkJobIds({
      repoDir: path.join(root, "repo"),
      publisherAppId,
      localAppDir: path.join(root, "local"),
      jobIds: [jobId],
    });
    const newId = remap.get(jobId)!;
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(jobId);

    const repo = path.join(root, "repo");
    await expect(fs.access(path.join(repo, "Jobs", jobId))).rejects.toThrow();
    const job = JSON.parse(await fs.readFile(path.join(repo, "Jobs", newId, "job.json"), "utf8"));
    expect(job.id).toBe(newId);
    expect(await fs.readFile(path.join(repo, "data", "jobs.json"), "utf8")).toContain(newId);
    const code = await fs.readFile(path.join(root, "local", "app.ts"), "utf8");
    expect(code).toContain(newId);
    expect(code).not.toContain(jobId);
  });
});
