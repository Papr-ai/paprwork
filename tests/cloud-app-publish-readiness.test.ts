import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assessAppFeatureAvailability,
  buildCloudPublishReadiness,
} from "../src/gateway/services/cloudAppPublishReadiness.js";
import { CLOUD_APP_DEPENDENCIES_FILENAME } from "../src/core/types/cloudAppDependencies.js";
import { resetJobsServiceSingletonForTests } from "../src/gateway/services/JobsService.js";

describe("cloudAppPublishReadiness", () => {
  let paprHome: string;
  let appId: string;
  let externalAppId: string;
  let externalDbId: string;
  let jobId: string;

  beforeEach(async () => {
    paprHome = path.join(
      process.cwd(),
      ".tmp-test-readiness",
      randomUUID(),
    );
    process.env.PAPR_HOME = paprHome;
    appId = randomUUID();
    externalAppId = randomUUID();
    externalDbId = randomUUID();
    jobId = randomUUID();

    await fs.mkdir(path.join(paprHome, "apps", appId, "jobs", jobId, "code"), {
      recursive: true,
    });
    await fs.mkdir(path.join(paprHome, "apps", externalAppId), {
      recursive: true,
    });
    await fs.mkdir(path.join(paprHome, "Jobs", jobId, "code"), {
      recursive: true,
    });
    await fs.mkdir(path.join(paprHome, "data"), { recursive: true });

    await fs.writeFile(
      path.join(paprHome, "apps", appId, "metadata.json"),
      JSON.stringify({ title: "Lead Prospector" }),
    );
    await fs.writeFile(
      path.join(paprHome, "apps", externalAppId, "metadata.json"),
      JSON.stringify({ title: "Contact Enrichment", slug: "contact-enrichment" }),
    );
    await fs.writeFile(
      path.join(paprHome, "apps", appId, "jobs", jobId, "job.json"),
      JSON.stringify({
        id: jobId,
        name: "Scout",
        type: "python",
        appIds: [appId],
        command: "python3 code/run.py",
      }),
    );
    await fs.writeFile(
      path.join(paprHome, "Jobs", jobId, "job.json"),
      JSON.stringify({
        id: jobId,
        name: "Scout",
        type: "python",
        appIds: [appId],
        command: "python3 code/run.py",
      }),
    );
    await fs.writeFile(
      path.join(paprHome, "data", "jobs.json"),
      JSON.stringify([
        {
          id: jobId,
          name: "Scout",
          type: "python",
          status: "pending",
          appIds: [appId],
          command: "python3 code/run.py",
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    await fs.writeFile(
      path.join(paprHome, "data", "apps.json"),
      JSON.stringify([
        { id: appId, title: "Lead Prospector" },
        { id: externalAppId, title: "Contact Enrichment", slug: "contact-enrichment" },
      ]),
    );
    await fs.writeFile(
      path.join(paprHome, "apps", appId, "data-sources.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            id: "scout",
            type: "sqlite",
            jobId,
            alias: "scout",
            dbPath: "",
            tables: [],
            linkedAt: new Date().toISOString(),
          },
          {
            id: "contacts",
            type: "sqlite",
            dbId: externalDbId,
            alias: "contacts",
            dbPath: "",
            tables: [],
            linkedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(paprHome, "data", "databases.json"),
      JSON.stringify({
        version: 1,
        databases: {
          [externalDbId]: {
            id: externalDbId,
            alias: "contacts",
            schemaOwnerAppId: externalAppId,
            status: "active",
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(paprHome, "data", "cloud-publish-prefs.json"),
      JSON.stringify({
        apps: {
          [externalAppId]: {
            autoPublish: true,
            accessMode: "public_read",
          },
        },
      }),
    );
  });

  afterEach(async () => {
    resetJobsServiceSingletonForTests();
    await fs.rm(paprHome, { recursive: true, force: true, maxRetries: 3 });
    delete process.env.PAPR_HOME;
  });

  it("builds publish readiness with optional linked apps", async () => {
    const readiness = await buildCloudPublishReadiness(paprHome, appId);
    expect(readiness.ok).toBe(true);
    expect(readiness.dependencies.apps).toHaveLength(1);
    expect(readiness.dependencies.apps[0]?.appId).toBe(externalAppId);
    expect(readiness.dependencies.apps[0]?.publishedToCommunity).toBe(true);
    expect(readiness.copyInstallNote).toContain("Contact Enrichment");
  });

  it("reports feature availability when optional apps are missing", async () => {
    await fs.writeFile(
      path.join(paprHome, "apps", appId, CLOUD_APP_DEPENDENCIES_FILENAME),
      JSON.stringify({
        schemaVersion: "1.0.0",
        updatedAt: new Date().toISOString(),
        apps: [
          {
            appId: externalAppId,
            title: "Contact Enrichment",
            slug: "contact-enrichment",
            required: false,
            enables: ["Send to enrichment"],
          },
        ],
        databases: [
          {
            dbId: externalDbId,
            alias: "contacts",
            ownerAppId: externalAppId,
            ownerTitle: "Contact Enrichment",
            ownerSlug: "contact-enrichment",
            required: false,
          },
        ],
      }),
    );

    const availability = await assessAppFeatureAvailability(paprHome, appId);
    expect(availability.features["contact-enrichment"]?.available).toBe(true);
    expect(availability.features.contacts?.available).toBe(true);
    expect(availability.optionalApps[0]?.installed).toBe(true);
  });

  it("marks features unavailable when dependency app is not installed", async () => {
    await fs.rm(path.join(paprHome, "apps", externalAppId), {
      recursive: true,
      force: true,
    });
    await fs.writeFile(
      path.join(paprHome, "data", "databases.json"),
      JSON.stringify({ version: 1, databases: {} }),
    );
    await fs.writeFile(
      path.join(paprHome, "apps", appId, CLOUD_APP_DEPENDENCIES_FILENAME),
      JSON.stringify({
        schemaVersion: "1.0.0",
        updatedAt: new Date().toISOString(),
        apps: [
          {
            appId: externalAppId,
            title: "Contact Enrichment",
            slug: "contact-enrichment",
            required: false,
          },
        ],
        databases: [],
      }),
    );

    const availability = await assessAppFeatureAvailability(paprHome, appId);
    expect(availability.features["contact-enrichment"]?.available).toBe(false);
    expect(availability.features["contact-enrichment"]?.reason).toContain(
      "Contact Enrichment",
    );
  });
});
