import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  assignAppToWorkspace,
  removeUnassignedDuplicateAppCopies,
} from "../src/gateway/services/appWorkspaceAssignment.js";
import {
  ensureWorkspaceLayout,
  resolveOrgNamespaceWorkspacePath,
} from "../src/core/utils/paprWorkspace.js";
import type { MiniApp } from "../src/gateway/services/AppService.js";

const APP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function writeAppIndex(
  paprHome: string,
  apps: MiniApp[],
): Promise<void> {
  const indexPath = path.join(paprHome, "data", "apps.json");
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(apps, null, 2), "utf8");
}

async function writeRunnableApp(
  paprHome: string,
  appId: string,
  title: string,
  linkedJobId?: string,
): Promise<void> {
  const appDir = path.join(paprHome, "apps", appId);
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(
    path.join(appDir, "index.html"),
    `<html><body>${title}</body></html>`,
    "utf8",
  );
  if (linkedJobId) {
    await fs.writeFile(
      path.join(appDir, "data-sources.json"),
      JSON.stringify(
        {
          sources: [
            {
              id: "primary",
              jobId: linkedJobId,
              dbPath: path.join(paprHome, "Jobs", linkedJobId, "data", "data.db"),
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
  }
}

async function writeLinkedJob(
  paprHome: string,
  jobId: string,
  appId: string,
): Promise<void> {
  const jobDir = path.join(paprHome, "Jobs", jobId);
  await fs.mkdir(path.join(jobDir, "data"), { recursive: true });
  await fs.writeFile(path.join(jobDir, "job.json"), "{}", "utf8");
  await fs.writeFile(path.join(jobDir, "data", "data.db"), "sqlite", "utf8");

  const jobsIndexPath = path.join(paprHome, "data", "jobs.json");
  await fs.mkdir(path.dirname(jobsIndexPath), { recursive: true });
  await fs.writeFile(
    jobsIndexPath,
    JSON.stringify(
      [
        {
          id: jobId,
          name: "Meetings sync",
          type: "python",
          command: "python3 main.py",
          appIds: [appId],
          status: "pending",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      null,
      2,
    ),
    "utf8",
  );
}

async function writeMetadataOnlyApp(
  paprHome: string,
  appId: string,
  title: string,
): Promise<void> {
  const appDir = path.join(paprHome, "apps", appId);
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(
    path.join(appDir, "metadata.json"),
    JSON.stringify({ title, description: title }, null, 2),
    "utf8",
  );
}

describe("appWorkspaceAssignment", () => {
  let tempHome = "";
  let previousHome: string | undefined;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "papr-assign-test-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    delete process.env.PAPR_HOME;
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    delete process.env.PAPR_HOME;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("merges runnable bundles into canonical workspace before deleting duplicates", async () => {
    await ensureWorkspaceLayout({
      organizationId: "org-canonical",
      namespaceId: "ns-canonical",
    });
    await ensureWorkspaceLayout({
      organizationId: "org-other",
      namespaceId: "ns-other",
    });

    const canonicalHome = resolveOrgNamespaceWorkspacePath(
      "org-canonical",
      "ns-canonical",
    );
    const otherHome = resolveOrgNamespaceWorkspacePath("org-other", "ns-other");

    await writeMetadataOnlyApp(canonicalHome, APP_ID, "MyAdvice Meetings");
    await writeRunnableApp(otherHome, APP_ID, "MyAdvice Meetings");
    await writeAppIndex(otherHome, [
      {
        id: APP_ID,
        title: "MyAdvice Meetings",
        description: "Meetings",
        type: "app",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const removedFrom = await removeUnassignedDuplicateAppCopies(APP_ID, {
      organizationId: "org-canonical",
      namespaceId: "ns-canonical",
    });

    expect(removedFrom).toContain(otherHome);
    await expect(
      fs.access(path.join(canonicalHome, "apps", APP_ID, "index.html")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(otherHome, "apps", APP_ID)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("assigns in-place by pulling app files from another namespace", async () => {
    await ensureWorkspaceLayout({
      organizationId: "org-myadvice",
      namespaceId: "ns-dev",
    });
    await ensureWorkspaceLayout({
      organizationId: "org-legacy",
      namespaceId: "ns-dev",
    });

    const targetHome = resolveOrgNamespaceWorkspacePath("org-myadvice", "ns-dev");
    const legacyHome = resolveOrgNamespaceWorkspacePath("org-legacy", "ns-dev");

    await writeRunnableApp(legacyHome, APP_ID, "MyAdvice Meetings");
    await writeMetadataOnlyApp(targetHome, APP_ID, "MyAdvice Meetings");
    await writeAppIndex(targetHome, [
      {
        id: APP_ID,
        title: "MyAdvice Meetings",
        description: "Meetings",
        type: "app",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const sourceApp: MiniApp = {
      id: APP_ID,
      title: "MyAdvice Meetings",
      description: "Meetings",
      type: "app",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await assignAppToWorkspace({
      appId: APP_ID,
      targetOrganizationId: "org-myadvice",
      targetNamespaceId: "ns-dev",
      sourcePaprHome: targetHome,
      sourceApp,
    });

    expect(result.action).toBe("assigned");
    await expect(
      fs.access(path.join(targetHome, "apps", APP_ID, "index.html")),
    ).resolves.toBeUndefined();

    const indexRaw = await fs.readFile(
      path.join(targetHome, "data", "apps.json"),
      "utf8",
    );
    const index = JSON.parse(indexRaw) as MiniApp[];
    expect(index[0]?.organizationId).toBe("org-myadvice");
    expect(index[0]?.namespaceId).toBe("ns-dev");
  });

  it("assigns linked jobs and databases when pulling app files from another namespace", async () => {
    const JOB_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    await ensureWorkspaceLayout({
      organizationId: "org-myadvice",
      namespaceId: "ns-dev",
    });
    await ensureWorkspaceLayout({
      organizationId: "org-legacy",
      namespaceId: "ns-dev",
    });

    const targetHome = resolveOrgNamespaceWorkspacePath("org-myadvice", "ns-dev");
    const legacyHome = resolveOrgNamespaceWorkspacePath("org-legacy", "ns-dev");

    await writeLinkedJob(legacyHome, JOB_ID, APP_ID);
    await writeRunnableApp(legacyHome, APP_ID, "MyAdvice Meetings", JOB_ID);
    await writeMetadataOnlyApp(targetHome, APP_ID, "MyAdvice Meetings");
    await writeAppIndex(targetHome, [
      {
        id: APP_ID,
        title: "MyAdvice Meetings",
        description: "Meetings",
        type: "app",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    await assignAppToWorkspace({
      appId: APP_ID,
      targetOrganizationId: "org-myadvice",
      targetNamespaceId: "ns-dev",
      sourcePaprHome: targetHome,
      sourceApp: {
        id: APP_ID,
        title: "MyAdvice Meetings",
        description: "Meetings",
        type: "app",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    await expect(
      fs.access(path.join(targetHome, "Jobs", JOB_ID, "data", "data.db")),
    ).resolves.toBeUndefined();

    const jobsRaw = await fs.readFile(
      path.join(targetHome, "data", "jobs.json"),
      "utf8",
    );
    const jobs = JSON.parse(jobsRaw) as Array<{ id: string; appIds?: string[] }>;
    expect(jobs.some((job) => job.id === JOB_ID)).toBe(true);
  });
});
