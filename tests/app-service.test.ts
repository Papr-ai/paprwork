import { afterEach, beforeEach, describe, expect, test } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { AppService } from "../src/gateway/services/AppService.js";

describe("AppService", () => {
  let originalHome: string | undefined;
  let testHomeDir: string;
  let appService: AppService;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    testHomeDir = path.join(os.tmpdir(), `paprwork-v2-app-service-${Date.now()}`);
    process.env.HOME = testHomeDir;
    await fs.mkdir(testHomeDir, { recursive: true });
    appService = new AppService();
    await appService.initialize();
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
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
    expect(deleted).toBe(true);
    expect(afterDelete).toBeNull();
  });

  test("links app data sources and persists mapping with primary", async () => {
    const app = await appService.createApp("Data App", "Desc", [
      { filename: "index.html", content: "<h1>Data App</h1>" },
    ]);

    const linked = await appService.linkAppDataSource(app.id, {
      id: "job-1:orders",
      type: "sqlite",
      jobId: "job-1",
      alias: "orders",
      dbPath: "/tmp/job-1/data.db",
      tables: ["orders", "order_items"],
      setPrimary: true,
    });

    expect(linked).toHaveLength(1);
    expect(linked[0].jobId).toBe("job-1");
    const config = await appService.getDataSourcesConfig(app.id);
    expect(config.primary).toBe("orders");
    const listed = await appService.listAppDataSources(app.id);
    expect(listed[0].alias).toBe("orders");
    const appPath = await appService.getAppPath(app.id);
    const raw = await fs.readFile(
      path.join(appPath as string, "data-sources.json"),
      "utf8",
    );
    expect(raw).toContain('"primary": "orders"');
    const dbTs = await fs.readFile(
      path.join(appPath as string, "db.ts"),
      "utf8",
    );
    expect(dbTs).toContain("PRIMARY_SOURCE = 'orders'");
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
      setPrimary: true,
    });

    const result = await appService.validateApp(app.id);

    expect(
      result.issues.some(
        (issue) => issue.rule === "linked-data-source-required",
      ),
    ).toBe(false);
  });
});
