import { afterEach, beforeEach, describe, expect, test } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { AppService } from "../src/gateway/services/AppService.js";

describe("AppService", () => {
  let originalHome: string | undefined;
  let originalPaprHome: string | undefined;
  let testHomeDir: string;
  let appService: AppService;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalPaprHome = process.env.PAPR_HOME;
    // Date.now() collides when two tests start in the same millisecond, which
    // silently shares one workspace between them.
    testHomeDir = path.join(
      os.tmpdir(),
      `paprwork-v2-app-service-${process.pid}-${randomUUID()}`,
    );
    process.env.HOME = testHomeDir;
    // HOME alone is not enough. getPaprRoot() prefers the active-workspace
    // pointer read from the developer's REAL home, and syncs PAPR_HOME to it —
    // so without this the suite creates apps in the user's live workspace
    // instead of a temp dir, and listApps() returns hundreds of real apps.
    process.env.PAPR_HOME = path.join(testHomeDir, "Papr");
    await fs.mkdir(path.join(testHomeDir, "Papr"), { recursive: true });
    appService = new AppService();
    await appService.initialize();
  });

  afterEach(async () => {
    // Stop watchers and pending timers before the temp dir goes away. Without
    // this, the tree watcher keeps firing on deleted paths and the debounced reload
    // broadcast outlives the test run.
    appService.cleanup();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalPaprHome === undefined) {
      delete process.env.PAPR_HOME;
    } else {
      process.env.PAPR_HOME = originalPaprHome;
    }
    await fs.rm(testHomeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  test("creates app with files and lists it", async () => {
    const created = await appService.createApp("Dashboard", "Mini app", [
      { filename: "index.html", content: "<h1>Dashboard</h1>" },
      { filename: "app.js", content: "console.log('ok');" },
    ]);
    const listed = await appService.listApps();
    const loadedFile = await appService.readAppFile(created.id, "index.html");

    expect(created.title).toBe("Dashboard");
    const ours = listed.find((a) => a.id === created.id);
    expect(ours).toBeDefined();
    expect(ours?.id).toBe(created.id);
    expect(loadedFile).toContain("Dashboard");
  });

  test("createApp auto-suffixes duplicate titles", async () => {
    const first = await appService.createApp("Mem0 Stargazers", "First", [
      { filename: "index.html", content: "<h1>1</h1>" },
    ]);
    const second = await appService.createApp("mem0 stargazers", "Second", [
      { filename: "index.html", content: "<h1>2</h1>" },
    ]);

    expect(first.title).toBe("Mem0 Stargazers");
    expect(second.title).toBe("mem0 stargazers_1");
  });

  test("createApp drops invalid icons instead of blocking install", async () => {
    const badIcon =
      '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="white"/><path d="M10 32h44" stroke="black"/></svg>';

    const created = await appService.createApp(
      "Monitor",
      "Desc",
      [{ filename: "index.html", content: "<h1>Hi</h1>" }],
      badIcon,
    );
    expect(created.icon).toBeUndefined();
  });

  test("createApp drops plain-text icons for community-style installs", async () => {
    const created = await appService.createApp(
      "Community App",
      "Desc",
      [{ filename: "index.html", content: "<h1>Hi</h1>" }],
      "chart",
    );
    expect(created.icon).toBeUndefined();
  });

  test("createApp scaffolds backend/manifest.json and ping.py", async () => {
    const created = await appService.createApp("Backend App", "Desc", [
      { filename: "index.html", content: "<h1>Hi</h1>" },
    ]);
    const appPath = path.join(testHomeDir, "Papr", "apps", created.id);
    const manifest = JSON.parse(
      await fs.readFile(path.join(appPath, "backend", "manifest.json"), "utf8"),
    ) as { version: number; actions: Record<string, { handler: string }> };
    const pingPy = await fs.readFile(path.join(appPath, "backend", "ping.py"), "utf8");

    expect(manifest.version).toBe(1);
    expect(manifest.actions.ping?.handler).toBe("ping.py");
    expect(pingPy).toContain("PAPR_ACTION_PARAMS");
  });

  test("validateApp errors on /api/bash/run in frontend code", async () => {
    const created = await appService.createApp("Bash App", "Desc", [
      { filename: "index.html", content: "<script src='app.ts'></script>" },
      {
        filename: "app.ts",
        content: `fetch('/api/bash/run', { method: 'POST', body: '{}' });`,
      },
    ]);
    await appService.buildApp(created.id);
    const result = await appService.validateApp(created.id);
    expect(
      result.issues.some(
        (i) => i.rule === "no-mini-app-bash" && i.severity === "error",
      ),
    ).toBe(true);
  });

  test("updates app metadata and file content", async () => {
    const created = await appService.createApp("Editor", "Desc", [
      { filename: "index.html", content: "v1" },
    ]);

    const updated = await appService.updateApp(created.id, {
      title: "Editor v2",
      description: "Updated",
    });
    const wrote = await appService.writeAppFile(created.id, "index.html", "v2");
    const loadedFile = await appService.readAppFile(created.id, "index.html");

    expect(updated?.title).toBe("Editor v2");
    expect(updated?.description).toBe("Updated");
    expect(wrote).toBe(true);
    expect(loadedFile).toBe("v2");
  });

  test("prunes index when app folder is removed outside deleteApp (e.g. bash rm)", async () => {
    const created = await appService.createApp("Orphan", "Desc", [
      { filename: "index.html", content: "<h1>x</h1>" },
    ]);
    const appPath = path.join(testHomeDir, "Papr", "apps", created.id);
    await fs.rm(appPath, { recursive: true, force: true });
    const listed = await appService.listApps();
    expect(listed.find((a) => a.id === created.id)).toBeUndefined();
  });

  test("toggles favorite and deletes app", async () => {
    const created = await appService.createApp("Tools", "Desc", [
      { filename: "index.html", content: "content" },
    ]);

    const favorited = await appService.toggleFavorite(created.id);
    const appPath = await appService.getAppPath(created.id);
    const deleted = await appService.deleteApp(created.id);
    const afterDelete = await appService.getApp(created.id);

    expect(favorited?.favorite).toBe(true);
    expect(appPath).toContain(created.id);
    // deleteApp returns DeleteAppResult (it may also need to unpublish from
    // cloud), not a bare boolean.
    expect(deleted.deleted).toBe(true);
    expect(afterDelete).toBeNull();
  });

  test("links app data sources and persists mapping with primary", async () => {
    const app = await appService.createApp("Data App", "Desc", [
      { filename: "index.html", content: "<h1>Data App</h1>" },
    ]);

    const linked =     await appService.linkAppDataSource(app.id, {
      id: "job-1:orders",
      type: "sqlite",
      jobId: "job-1",
      alias: "orders",
      dbPath: "/tmp/job-1/data.db",
      tables: ["orders", "order_items"],
    });

    expect(linked).toHaveLength(1);
    expect(linked[0].jobId).toBe("job-1");
    const config = await appService.getDataSourcesConfig(app.id);
    expect(config.sources).toHaveLength(1);
    expect(config.primary).toBeUndefined();
    const listed = await appService.listAppDataSources(app.id);
    expect(listed[0].alias).toBe("orders");
    const appPath = await appService.getAppPath(app.id);
    const raw = await fs.readFile(
      path.join(appPath as string, "data-sources.json"),
      "utf8",
    );
    expect(raw).not.toContain('"primary"');
    const dbTs = await fs.readFile(
      path.join(appPath as string, "db.ts"),
      "utf8",
    );
    expect(dbTs).toContain("sourceId: string");
    expect(dbTs).not.toContain("DEFAULT_SOURCE");
  });

  test("allows linking multiple databases to one app", async () => {
    const app = await appService.createApp("Multi DB", "Desc", [
      { filename: "index.html", content: "<h1>Multi</h1>" },
    ]);

    await appService.linkAppDataSource(app.id, {
      id: "db-a:metrics",
      type: "sqlite",
      dbId: "db-a",
      alias: "metrics",
      dbPath: "/tmp/metrics/data.db",
      tables: [],
    });

    const linked = await appService.linkAppDataSource(app.id, {
      id: "db-b:billing",
      type: "sqlite",
      dbId: "db-b",
      alias: "billing",
      dbPath: "/tmp/billing/data.db",
      tables: [],
    });

    expect(linked).toHaveLength(2);
    const config = await appService.getDataSourcesConfig(app.id);
    expect(config.sources).toHaveLength(2);
    expect(config.primary).toBeUndefined();
  });

  test("validateApp blocks /api/db/* when no data source is linked", async () => {
    const app = await appService.createApp("DB UI", "Desc", [
      { filename: "index.html", content: "<div id='app'></div>" },
      {
        filename: "app.ts",
        content:
          "export async function load() { await fetch('/api/db/query', { method: 'POST' }); }",
      },
    ]);

    const result = await appService.validateApp(app.id);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (issue) => issue.rule === "linked-data-source-required",
      ),
    ).toBe(true);
  });

  test("validateApp passes when /api/db/* app has linked data source", async () => {
    const app = await appService.createApp("Linked DB UI", "Desc", [
      { filename: "index.html", content: "<div id='app'></div>" },
      {
        filename: "app.ts",
        content:
          "export async function load() { await fetch('/api/db/query', { method: 'POST' }); }",
      },
    ]);

    await appService.linkAppDataSource(app.id, {
      id: "job-1:data",
      type: "sqlite",
      jobId: "job-1",
      alias: "data",
      dbPath: "/tmp/job-1/data.db",
      tables: [],
    });

    const result = await appService.validateApp(app.id);

    expect(
      result.issues.some(
        (issue) => issue.rule === "linked-data-source-required",
      ),
    ).toBe(false);
  });

  test("validateApp does not enforce line limit on markdown report files", async () => {
    const longMd = Array.from(
      { length: 150 },
      (_, i) => `## Section ${i + 1}\n\nReport finding paragraph ${i + 1}.`,
    ).join("\n\n");
    const app = await appService.createApp("Report App", "Desc", [
      {
        filename: "index.html",
        content:
          '<!DOCTYPE html><html><body><div id="app"></div><script type="module" src="dist/app.js"></script></body></html>',
      },
      { filename: "app.ts", content: "console.log('ok');" },
      { filename: "content/reports/audit.md", content: longMd },
    ]);
    await appService.buildApp(app.id);
    const result = await appService.validateApp(app.id);

    expect(
      result.issues.filter(
        (issue) => issue.rule === "max-lines" && issue.file.endsWith(".md"),
      ),
    ).toHaveLength(0);
  });

  test("listAppFiles returns nested paths including content/reports", async () => {
    const app = await appService.createApp("Nested Files App", "Desc", [
      { filename: "index.html", content: "<h1>Hi</h1>" },
      { filename: "content/reports/audit.md", content: "# Audit\n\nFindings here." },
      { filename: "components/chart.ts", content: "export {};" },
    ]);

    const files = await appService.listAppFiles(app.id);

    expect(files).toContain("content/reports/audit.md");
    expect(files).toContain("components/chart.ts");
    expect(files).toContain("index.html");
  });

  test("validateApp enforces line limit on TypeScript source files", async () => {
    const longTs = Array.from(
      { length: 120 },
      (_, i) => `export const value${i} = ${i};`,
    ).join("\n");
    const app = await appService.createApp("Long TS App", "Desc", [
      {
        filename: "index.html",
        content:
          '<!DOCTYPE html><html><body><div id="app"></div><script type="module" src="dist/app.js"></script></body></html>',
      },
      { filename: "app.ts", content: longTs },
    ]);
    await appService.buildApp(app.id);
    const result = await appService.validateApp(app.id);

    expect(
      result.issues.some(
        (issue) => issue.rule === "max-lines" && issue.file === "app.ts",
      ),
    ).toBe(true);
  });

  test("validateApp exempts auto-injected base.css from line limit", async () => {
    const longCss = Array.from(
      { length: 150 },
      (_, i) => `.token-${i} { color: #${String(i).padStart(6, "0")}; }`,
    ).join("\n");
    const app = await appService.createApp("Long Base CSS App", "Desc", [
      {
        filename: "index.html",
        content:
          '<!DOCTYPE html><html><head><link rel="stylesheet" href="base.css"></head><body><div id="app"></div><script type="module" src="dist/app.js"></script></body></html>',
      },
      { filename: "app.ts", content: "console.log('ok');" },
      { filename: "base.css", content: longCss },
    ]);
    await appService.buildApp(app.id);
    const result = await appService.validateApp(app.id);

    expect(
      result.issues.filter(
        (issue) => issue.rule === "max-lines" && issue.file === "base.css",
      ),
    ).toHaveLength(0);
  });

  test("rebuildIndexIfCorrupted reads metadata.json instead of placeholder description", async () => {
    const appId = "11111111-1111-4111-8111-111111111111";
    const appDir = path.join(testHomeDir, "Papr", "apps", appId);
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, "index.html"),
      "<html><head><title>HTML Title Only</title></head></html>",
      "utf8",
    );
    await fs.writeFile(
      path.join(appDir, "metadata.json"),
      JSON.stringify(
        {
          appId,
          title: "Team Meetings App",
          description: "Shared via cloud sync",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    const recovered = new AppService();
    await recovered.initialize();
    const app = (await recovered.listApps()).find((entry) => entry.id === appId);

    expect(app?.title).toBe("Team Meetings App");
    expect(app?.description).toBe("Shared via cloud sync");
  });

  test("listApps excludes apps owned by another Papr user", async () => {
    process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = "user-me";
    const appId = "22222222-2222-4222-8222-222222222222";
    const appDir = path.join(testHomeDir, "Papr", "apps", appId);
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, "index.html"), "<h1>Foreign</h1>", "utf8");
    await fs.writeFile(
      path.join(appDir, "metadata.json"),
      JSON.stringify({
        appId,
        title: "Teammate Private App",
        description: "Not mine",
        ownerUserId: "user-teammate",
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const dataDir = path.join(testHomeDir, "Papr", "data");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "apps.json"),
      JSON.stringify([
        {
          id: appId,
          title: "Teammate Private App",
          description: "Not mine",
          type: "app",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
      "utf8",
    );

    const scoped = new AppService();
    await scoped.initialize();
    expect((await scoped.listApps()).some((entry) => entry.id === appId)).toBe(
      false,
    );
  });
});
