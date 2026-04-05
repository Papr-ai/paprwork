import { describe, expect, test } from "vitest";
import {
  BUNDLE_SCHEMA_VERSION,
  BundleManifestSchema,
  parseBundleManifest,
} from "../src/core/types/bundles.js";

describe("bundle manifest schema", () => {
  test("parses valid portable bundle", () => {
    const manifest = parseBundleManifest({
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      bundleId: "bundle-twitter-intel",
      name: "Twitter Intelligence Suite",
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      minPaprworkVersion: "2.0.0",
      app: {
        id: "app-twitter-dashboard",
        name: "Twitter Dashboard",
        version: "1.0.0",
        entryFile: "index.html",
        appPath: "apps/app-twitter-dashboard",
      },
      jobs: [
        {
          id: "job-scraper",
          name: "Tweet Scraper",
          type: "python",
          entryPoint: "code/scraper.py",
          outputTables: ["tweets"],
        },
        {
          id: "job-insights",
          name: "Insights Generator",
          type: "agent",
          dependsOn: [{ jobId: "job-scraper", onStatus: ["completed"] }],
          outputTables: ["insights"],
        },
      ],
      sqlite: [
        {
          id: "main",
          path: "jobs/job-scraper/data.db",
          migrationsPath: "jobs/job-scraper/migrations",
          tables: [
            {
              name: "tweets",
              primaryKey: "id",
              columns: ["id", "text", "created_at"],
              indexes: [{ name: "idx_tweets_created", columns: ["created_at"] }],
            },
          ],
        },
      ],
      deploymentProfiles: [
        {
          id: "local-default",
          name: "Local Default",
          runtimeTarget: "local",
          environment: {},
        },
      ],
      sync: {
        preferredRoot: "~/Papr",
        bundleSubpath: "bundles",
        cloudReady: true,
      },
    });

    expect(manifest.bundleId).toBe("bundle-twitter-intel");
    expect(manifest.jobs).toHaveLength(2);
    expect(manifest.sqlite[0].tables[0].name).toBe("tweets");
  });

  test("rejects invalid runtime type", () => {
    const result = BundleManifestSchema.safeParse({
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      bundleId: "b1",
      name: "Invalid Bundle",
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      minPaprworkVersion: "2.0.0",
      app: {
        id: "a1",
        name: "Invalid App",
        version: "1.0.0",
        entryFile: "index.html",
        appPath: "apps/a1",
      },
      jobs: [
        {
          id: "job-invalid",
          name: "Invalid",
          type: "ruby",
        },
      ],
      sqlite: [],
    });

    expect(result.success).toBe(false);
  });
});
