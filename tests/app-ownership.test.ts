import { afterEach, beforeEach, describe, expect, test } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import {
  isAppOwnedByCurrentUser,
  readAppDiskOwnershipHints,
  shouldIndexAppFolderForCurrentUser,
} from "../src/gateway/services/appOwnership.js";
import type { MiniApp } from "../src/gateway/services/AppService.js";
import { CLOUD_LINEAGE_FILENAME } from "../src/gateway/services/CloudAppLineageService.js";

describe("app ownership", () => {
  let testDir: string;
  let originalUserId: string | undefined;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `papr-app-ownership-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    originalUserId = process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID;
    process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = "user-me";
  });

  afterEach(async () => {
    if (originalUserId === undefined) {
      delete process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID;
    } else {
      process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = originalUserId;
    }
    await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  test("installed fork is owned by current user even when upstream publisher differs", async () => {
    const appDir = path.join(testDir, "fork-app");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, CLOUD_LINEAGE_FILENAME),
      JSON.stringify({
        schemaVersion: "1.1.0",
        lineageId: "lineage-1",
        mode: "fork",
        source: {
          orgId: "org",
          namespaceId: "ns",
          userId: "user-teammate",
          appId: "publisher-app-id",
          slug: "demo",
        },
        installedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const hints = await readAppDiskOwnershipHints(appDir, "fork-app");
    const app: MiniApp = {
      id: "fork-app",
      title: "Demo Fork",
      description: "",
      type: "app",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerUserId: "user-me",
    };

    expect(hints.isInstalledFork).toBe(true);
    expect(isAppOwnedByCurrentUser(app, hints)).toBe(true);
  });

  test("publisher copy synced with matching app id is foreign", async () => {
    const appDir = path.join(testDir, "publisher-app-id");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, "metadata.json"),
      JSON.stringify({
        appId: "publisher-app-id",
        title: "Teammate App",
        description: "From teammate",
        ownerUserId: "user-teammate",
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const hints = await readAppDiskOwnershipHints(appDir, "publisher-app-id");
    const app: MiniApp = {
      id: "publisher-app-id",
      title: "Teammate App",
      description: "",
      type: "app",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(isAppOwnedByCurrentUser(app, hints)).toBe(false);
  });

  test("shouldIndexAppFolder rejects team catalog foreign app ids", async () => {
    const appDir = path.join(testDir, "team-app");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, "index.html"),
      "<html><title>Team</title></html>",
      "utf8",
    );

    const foreign = new Map([["team-app", "user-teammate"]]);
    const allowed = await shouldIndexAppFolderForCurrentUser(
      "team-app",
      appDir,
      foreign,
    );
    expect(allowed).toBe(false);
  });

  test("shouldIndexAppFolder keeps locally owned app even when team catalog lists teammate publisher", async () => {
    const appDir = path.join(testDir, "shared-app-id");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, "metadata.json"),
      JSON.stringify({
        appId: "shared-app-id",
        title: "Blog Topic Planner",
        description: "Mine",
        ownerUserId: "user-me",
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const foreign = new Map([["shared-app-id", "user-teammate"]]);
    const allowed = await shouldIndexAppFolderForCurrentUser(
      "shared-app-id",
      appDir,
      foreign,
    );
    expect(allowed).toBe(true);
  });

  test("ownerUserId on index entry gates access when logged in", async () => {
    const app: MiniApp = {
      id: "a1",
      title: "Mine",
      description: "",
      type: "app",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerUserId: "user-other",
    };
    expect(isAppOwnedByCurrentUser(app)).toBe(false);
  });
});
