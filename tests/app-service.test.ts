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
    await fs.rm(testHomeDir, { recursive: true, force: true });
  });

  test("creates app with files and lists it", async () => {
    const created = await appService.createApp("Dashboard", "Mini app", [
      { filename: "index.html", content: "<h1>Dashboard</h1>" },
      { filename: "app.js", content: "console.log('ok');" },
    ]);
    const listed = await appService.listApps();
    const loadedFile = await appService.readAppFile(created.id, "index.html");

    expect(created.title).toBe("Dashboard");
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);
    expect(loadedFile).toContain("Dashboard");
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

  test("links app data sources and persists mapping", async () => {
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
    });

    expect(linked).toHaveLength(1);
    expect(linked[0].jobId).toBe("job-1");
    const listed = await appService.listAppDataSources(app.id);
    expect(listed[0].alias).toBe("orders");
    const appPath = await appService.getAppPath(app.id);
    const raw = await fs.readFile(
      path.join(appPath as string, "data-sources.json"),
      "utf8",
    );
    expect(raw).toContain("orders");
  });
});
