import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  ACTIVE_WORKSPACE_FILENAME,
  ensureWorkspaceLayout,
  LEGACY_MIGRATION_FILENAME,
  migrateLegacyFlatPaprLayout,
  readActiveWorkspacePointer,
  relocateMisplacedLegacyMigration,
  relocateMisplacedNamespaceContent,
  resolveOrgNamespaceUserDataPath,
  resolveOrgNamespaceWorkspacePath,
  runLegacyWorkspaceDataMigration,
  runUserConsentFlatPaprMigration,
  detectUnmigratedFlatPaprContent,
  isPaprRootGlobalDataDir,
  listUnmigratedFlatPaprEntries,
  writeActiveWorkspacePointer,
} from "../src/core/utils/paprWorkspace.js";
import { getPaprRoot, getPaprDataDir, getPaprDocumentsDir } from "../src/core/utils/paprRoot.js";
import { buildCloudReposRequestBody } from "../src/core/utils/cloudReposScope.js";

describe("papr workspace hierarchy", () => {
  let tempHome = "";
  let previousHome: string | undefined;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "papr-workspace-test-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    delete process.env.PAPR_HOME;
    delete process.env.PAPR_USER_DATA;
    delete process.env.PAPR_ORG_ID;
    delete process.env.PAPR_NAMESPACE_ID;
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    delete process.env.PAPR_HOME;
    delete process.env.PAPR_USER_DATA;
    delete process.env.PAPR_ORG_ID;
    delete process.env.PAPR_NAMESPACE_ID;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("resolves org/namespace workspace and user-data paths", () => {
    expect(resolveOrgNamespaceWorkspacePath("org-a", "ns-b")).toBe(
      path.join(tempHome, "Papr", "orgs", "org-a", "namespaces", "ns-b"),
    );
    expect(resolveOrgNamespaceUserDataPath("org-a", "ns-b")).toBe(
      path.join(tempHome, ".paprwork-v2", "orgs", "org-a", "namespaces", "ns-b"),
    );
  });

  it("writes active workspace pointer and resolves getPaprRoot from it", async () => {
    const pointer = await ensureWorkspaceLayout({
      organizationId: "org-1",
      namespaceId: "ns-1",
      organizationName: "Acme",
      namespaceName: "Production",
    });

    expect(pointer.paprHome).toBe(
      path.join(tempHome, "Papr", "orgs", "org-1", "namespaces", "ns-1"),
    );

    const saved = readActiveWorkspacePointer();
    expect(saved?.organizationId).toBe("org-1");
    expect(saved?.namespaceId).toBe("ns-1");
    expect(getPaprRoot()).toBe(pointer.paprHome);
    expect(getPaprDataDir()).toBe(path.join(pointer.paprHome, "data"));
  });

  it("migrates legacy flat Papr folders into the active namespace once", async () => {
    const baseDir = path.join(tempHome, "Papr");
    await fs.mkdir(path.join(baseDir, "apps", "app-1"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "apps", "app-1", "index.html"),
      "<html></html>",
      "utf8",
    );
    await fs.mkdir(path.join(baseDir, "data"), { recursive: true });
    await fs.writeFile(path.join(baseDir, "data", "apps.json"), "[]", "utf8");

    const target = resolveOrgNamespaceWorkspacePath("org-legacy", "ns-legacy");
    await fs.mkdir(target, { recursive: true });

    const migrated = await migrateLegacyFlatPaprLayout({
      organizationId: "org-legacy",
      namespaceId: "ns-legacy",
      targetPaprHome: target,
    });

    expect(migrated?.movedPaths.sort()).toEqual(["apps", "data"]);
    await expect(fs.access(path.join(target, "apps", "app-1", "index.html"))).resolves
      .toBeUndefined();
    await expect(fs.access(path.join(baseDir, "apps"))).rejects.toThrow();
  });

  it("migrates legacy folders even when empty target dirs were pre-created", async () => {
    const baseDir = path.join(tempHome, "Papr");
    await fs.mkdir(path.join(baseDir, "apps", "app-1"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "apps", "app-1", "index.html"),
      "<html></html>",
      "utf8",
    );

    const pointer = await ensureWorkspaceLayout({
      organizationId: "org-precreated",
      namespaceId: "ns-precreated",
    });

    const migrated = await migrateLegacyFlatPaprLayout({
      organizationId: "org-precreated",
      namespaceId: "ns-precreated",
      targetPaprHome: pointer.paprHome,
    });

    expect(migrated?.movedPaths).toContain("apps");
    await expect(
      fs.access(path.join(pointer.paprHome, "apps", "app-1", "index.html")),
    ).resolves.toBeUndefined();
  });

  it("resumes partial legacy migration for remaining directories", async () => {
    const baseDir = path.join(tempHome, "Papr");
    const target = resolveOrgNamespaceWorkspacePath("org-partial", "ns-partial");
    await fs.mkdir(path.join(target, "apps"), { recursive: true });
    await fs.mkdir(path.join(baseDir, "Jobs", "job-1"), { recursive: true });
    await fs.writeFile(path.join(baseDir, "Jobs", "job-1", "run.sh"), "#!/bin/sh", "utf8");

    await writeActiveWorkspacePointer({
      organizationId: "org-partial",
      namespaceId: "ns-partial",
      paprHome: target,
      userDataPath: resolveOrgNamespaceUserDataPath("org-partial", "ns-partial"),
      activatedAt: new Date().toISOString(),
    });
    await fs.writeFile(
      path.join(baseDir, LEGACY_MIGRATION_FILENAME),
      JSON.stringify({
        migratedAt: new Date().toISOString(),
        organizationId: "org-partial",
        namespaceId: "ns-partial",
        targetPaprHome: target,
        movedPaths: ["apps"],
      }),
      "utf8",
    );

    const migrated = await migrateLegacyFlatPaprLayout({
      organizationId: "org-partial",
      namespaceId: "ns-partial",
      targetPaprHome: target,
    });

    expect(migrated?.movedPaths).toContain("Jobs");
    await expect(fs.access(path.join(target, "Jobs", "job-1", "run.sh"))).resolves
      .toBeUndefined();
  });

  it("merges legacy documents when target namespace already has documents", async () => {
    const baseDir = path.join(tempHome, "Papr");
    const target = resolveOrgNamespaceWorkspacePath("org-docs", "ns-docs");

    await fs.mkdir(path.join(baseDir, "documents", "legacy-doc"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "documents", "legacy-doc", "content.md"),
      "# Legacy doc",
      "utf8",
    );
    await fs.mkdir(path.join(target, "documents", "new-doc"), { recursive: true });
    await fs.writeFile(
      path.join(target, "documents", "new-doc", "content.md"),
      "# New doc",
      "utf8",
    );

    const migrated = await migrateLegacyFlatPaprLayout({
      organizationId: "org-docs",
      namespaceId: "ns-docs",
      targetPaprHome: target,
    });

    expect(migrated?.movedPaths).toContain("documents");
    await expect(
      fs.access(path.join(target, "documents", "legacy-doc", "content.md")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(target, "documents", "new-doc", "content.md")),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(baseDir, "documents"))).rejects.toThrow();
  });

  it("resumes documents migration when record says moved but flat legacy still has files", async () => {
    const baseDir = path.join(tempHome, "Papr");
    const target = resolveOrgNamespaceWorkspacePath("org-stuck", "ns-stuck");

    await fs.mkdir(path.join(baseDir, "documents", "stuck-doc"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "documents", "stuck-doc", "content.md"),
      "# Stuck doc",
      "utf8",
    );

    await fs.writeFile(
      path.join(baseDir, LEGACY_MIGRATION_FILENAME),
      JSON.stringify({
        migratedAt: new Date().toISOString(),
        organizationId: "org-stuck",
        namespaceId: "ns-stuck",
        targetPaprHome: target,
        movedPaths: ["documents"],
      }),
      "utf8",
    );

    const migrated = await migrateLegacyFlatPaprLayout({
      organizationId: "org-stuck",
      namespaceId: "ns-stuck",
      targetPaprHome: target,
    });

    expect(migrated?.movedPaths).toContain("documents");
    await expect(
      fs.access(path.join(target, "documents", "stuck-doc", "content.md")),
    ).resolves.toBeUndefined();
  });

  it("resolves getPaprRoot from active workspace pointer over stale PAPR_HOME", async () => {
    const pointer = await ensureWorkspaceLayout({
      organizationId: "org-pointer",
      namespaceId: "ns-pointer",
    });
    await fs.mkdir(path.join(pointer.paprHome, "documents", "doc-1"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(pointer.paprHome, "documents", "doc-1", "meta.json"),
      JSON.stringify({
        id: "doc-1",
        title: "Visible Doc",
        type: "document",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        tags: [],
        favorite: false,
        preview: "hello",
        wordCount: 1,
      }),
      "utf8",
    );

    process.env.PAPR_HOME = path.join(tempHome, "Papr");
    await fs.mkdir(path.join(process.env.PAPR_HOME, "documents"), { recursive: true });

    expect(getPaprRoot()).toBe(pointer.paprHome);
    expect(getPaprDocumentsDir()).toBe(path.join(pointer.paprHome, "documents"));
  });

  it("includes namespace_id in cloud repo requests when workspace is active", async () => {
    await writeActiveWorkspacePointer({
      organizationId: "org-x",
      namespaceId: "ns-y",
      paprHome: resolveOrgNamespaceWorkspacePath("org-x", "ns-y"),
      userDataPath: resolveOrgNamespaceUserDataPath("org-x", "ns-y"),
      activatedAt: new Date().toISOString(),
    });

    expect(buildCloudReposRequestBody("namespace")).toEqual({
      scope: "namespace",
      namespace_id: "ns-y",
    });
    expect(buildCloudReposRequestBody("user")).toEqual({
      scope: "user",
      namespace_id: "ns-y",
      template: "default",
    });
  });

  it("merges legacy apps when target only contains bundled default app", async () => {
    const baseDir = path.join(tempHome, "Papr");
    await fs.mkdir(path.join(baseDir, "apps", "legacy-app"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "apps", "legacy-app", "index.html"),
      "<html></html>",
      "utf8",
    );

    const pointer = await ensureWorkspaceLayout({
      organizationId: "org-merge",
      namespaceId: "ns-merge",
    });
    await fs.mkdir(
      path.join(pointer.paprHome, "apps", "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c"),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(
        pointer.paprHome,
        "apps",
        "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c",
        "index.html",
      ),
      "<html>home</html>",
      "utf8",
    );

    const migrated = await migrateLegacyFlatPaprLayout({
      organizationId: "org-merge",
      namespaceId: "ns-merge",
      targetPaprHome: pointer.paprHome,
    });

    expect(migrated?.movedPaths).toContain("apps");
    await expect(
      fs.access(path.join(pointer.paprHome, "apps", "legacy-app", "index.html")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(
        path.join(
          pointer.paprHome,
          "apps",
          "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c",
          "index.html",
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("prefers newer legacy file over larger older file during data merge", async () => {
    const baseDir = path.join(tempHome, "Papr");
    const pointer = await ensureWorkspaceLayout({
      organizationId: "org-mtime",
      namespaceId: "ns-mtime",
    });

    await fs.mkdir(path.join(baseDir, "data"), { recursive: true });
    await fs.mkdir(path.join(pointer.paprHome, "data"), { recursive: true });

    const legacyAppsJson = path.join(baseDir, "data", "apps.json");
    const targetAppsJson = path.join(pointer.paprHome, "data", "apps.json");

    await fs.writeFile(
      legacyAppsJson,
      JSON.stringify([{ id: "old-large", title: "x".repeat(500) }]),
      "utf8",
    );
    await fs.writeFile(
      targetAppsJson,
      JSON.stringify([{ id: "new-small" }]),
      "utf8",
    );

    const oldTime = new Date("2020-01-01");
    const newTime = new Date("2025-01-01");
    await fs.utimes(legacyAppsJson, oldTime, oldTime);
    await fs.utimes(targetAppsJson, newTime, newTime);

    await migrateLegacyFlatPaprLayout({
      organizationId: "org-mtime",
      namespaceId: "ns-mtime",
      targetPaprHome: pointer.paprHome,
    });

    const kept = await fs.readFile(targetAppsJson, "utf8");
    expect(kept).toContain("new-small");
    expect(kept).not.toContain("old-large");
  });

  it("migrates legacy chats.db into namespace user-data when target db is empty", async () => {
    const legacyBase = path.join(tempHome, ".paprwork-v2");
    await fs.mkdir(legacyBase, { recursive: true });
    await fs.writeFile(path.join(legacyBase, "chats.db"), "legacy-chat-data", "utf8");

    const userDataPath = resolveOrgNamespaceUserDataPath("org-chat", "ns-chat");
    await fs.mkdir(userDataPath, { recursive: true });

    const { migrateLegacyUserDataRuntime } = await import(
      "../src/core/utils/paprWorkspace.js"
    );
    const moved = await migrateLegacyUserDataRuntime({
      organizationId: "org-chat",
      namespaceId: "ns-chat",
      targetPaprHome: resolveOrgNamespaceWorkspacePath("org-chat", "ns-chat"),
      targetUserDataPath: userDataPath,
    });

    expect(moved).toContain("chats.db");
    const contents = await fs.readFile(path.join(userDataPath, "chats.db"), "utf8");
    expect(contents).toBe("legacy-chat-data");
    await expect(fs.access(path.join(legacyBase, "chats.db"))).rejects.toThrow();
  });

  it("relocates legacy data migrated into the wrong org/namespace workspace", async () => {
    const wrongHome = resolveOrgNamespaceWorkspacePath("crwNcCnClI", "VIA2C5VDxj");
    const correctHome = resolveOrgNamespaceWorkspacePath("org-home", "ns-home");
    await fs.mkdir(path.join(wrongHome, "documents", "doc-1"), { recursive: true });
    await fs.writeFile(
      path.join(wrongHome, "documents", "doc-1", "readme.md"),
      "hello",
      "utf8",
    );
    await fs.mkdir(correctHome, { recursive: true });

    await fs.writeFile(
      path.join(tempHome, "Papr", LEGACY_MIGRATION_FILENAME),
      JSON.stringify({
        migratedAt: new Date().toISOString(),
        organizationId: "crwNcCnClI",
        namespaceId: "VIA2C5VDxj",
        targetPaprHome: wrongHome,
        movedPaths: ["documents"],
      }),
      "utf8",
    );

    const relocated = await relocateMisplacedLegacyMigration({
      organizationId: "org-home",
      namespaceId: "ns-home",
      targetPaprHome: correctHome,
      targetUserDataPath: resolveOrgNamespaceUserDataPath("org-home", "ns-home"),
    });

    expect(relocated?.relocatedPaths).toContain("documents");
    await expect(
      fs.access(path.join(correctHome, "documents", "doc-1", "readme.md")),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(wrongHome, "documents"))).rejects.toThrow();

    const record = JSON.parse(
      await fs.readFile(path.join(tempHome, "Papr", LEGACY_MIGRATION_FILENAME), "utf8"),
    );
    expect(record.organizationId).toBe("org-home");
    expect(record.namespaceId).toBe("ns-home");
    expect(record.targetPaprHome).toBe(correctHome);
  });

  it("consolidates Papr folders from other org/namespace workspaces into the active one", async () => {
    const wrongHome = resolveOrgNamespaceWorkspacePath("wrong-org", "wrong-ns");
    const correctHome = resolveOrgNamespaceWorkspacePath("org-home", "ns-home");
    await fs.mkdir(path.join(wrongHome, "documents", "doc-1"), { recursive: true });
    await fs.writeFile(
      path.join(wrongHome, "documents", "doc-1", "content.md"),
      "hello",
      "utf8",
    );
    await fs.mkdir(path.join(wrongHome, "Chats", "chat-1"), { recursive: true });
    await fs.writeFile(
      path.join(wrongHome, "Chats", "chat-1", "history.jsonl"),
      "{}",
      "utf8",
    );
    await fs.mkdir(correctHome, { recursive: true });

    const consolidated = await relocateMisplacedNamespaceContent({
      targetPaprHome: correctHome,
    });

    expect(consolidated?.relocatedPaths).toEqual(
      expect.arrayContaining(["documents", "Chats"]),
    );
    await expect(
      fs.access(path.join(correctHome, "documents", "doc-1", "content.md")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(correctHome, "Chats", "chat-1", "history.jsonl")),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(wrongHome, "documents"))).rejects.toThrow();
    await expect(fs.access(path.join(wrongHome, "Chats"))).rejects.toThrow();
  });

  it("merges legacy apps when target has metadata-only app scaffolds", async () => {
    const baseDir = path.join(tempHome, "Papr");
    await fs.mkdir(path.join(baseDir, "apps", "legacy-app"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "apps", "legacy-app", "index.html"),
      "<html>legacy</html>",
      "utf8",
    );
    await fs.writeFile(
      path.join(baseDir, "apps", "legacy-app", "app.ts"),
      "export {}",
      "utf8",
    );

    const pointer = await ensureWorkspaceLayout({
      organizationId: "org-scaffold",
      namespaceId: "ns-scaffold",
    });
    await fs.mkdir(path.join(pointer.paprHome, "apps", "legacy-app"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(pointer.paprHome, "apps", "legacy-app", "metadata.json"),
      JSON.stringify({ title: "Legacy App" }),
      "utf8",
    );

    const migrated = await migrateLegacyFlatPaprLayout({
      organizationId: "org-scaffold",
      namespaceId: "ns-scaffold",
      targetPaprHome: pointer.paprHome,
    });

    expect(migrated?.movedPaths).toContain("apps");
    await expect(
      fs.access(path.join(pointer.paprHome, "apps", "legacy-app", "index.html")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(pointer.paprHome, "apps", "legacy-app", "app.ts")),
    ).resolves.toBeUndefined();
  });

  it("repairs incomplete apps even when target namespace has other complete apps", async () => {
    const sourceHome = resolveOrgNamespaceWorkspacePath("org-mix", "ns-source");
    const targetHome = resolveOrgNamespaceWorkspacePath("org-mix", "ns-target");

    await fs.mkdir(path.join(sourceHome, "apps", "complete-app"), { recursive: true });
    await fs.writeFile(
      path.join(sourceHome, "apps", "complete-app", "index.html"),
      "<html>complete</html>",
      "utf8",
    );
    await fs.mkdir(path.join(sourceHome, "apps", "needs-repair"), { recursive: true });
    await fs.writeFile(
      path.join(sourceHome, "apps", "needs-repair", "index.html"),
      "<html>repair me</html>",
      "utf8",
    );
    await fs.writeFile(
      path.join(sourceHome, "apps", "needs-repair", "app.ts"),
      "export {}",
      "utf8",
    );

    await fs.mkdir(path.join(targetHome, "apps", "complete-app"), { recursive: true });
    await fs.writeFile(
      path.join(targetHome, "apps", "complete-app", "index.html"),
      "<html>already here</html>",
      "utf8",
    );
    await fs.mkdir(path.join(targetHome, "apps", "needs-repair"), { recursive: true });
    await fs.writeFile(
      path.join(targetHome, "apps", "needs-repair", "metadata.json"),
      JSON.stringify({ title: "Needs repair" }),
      "utf8",
    );

    const consolidated = await relocateMisplacedNamespaceContent({
      targetPaprHome: targetHome,
    });

    expect(consolidated?.relocatedPaths).toContain("apps");
    await expect(
      fs.readFile(path.join(targetHome, "apps", "needs-repair", "index.html"), "utf8"),
    ).resolves.toContain("repair me");
    await expect(
      fs.readFile(path.join(targetHome, "apps", "complete-app", "index.html"), "utf8"),
    ).resolves.toContain("already here");
  });

  it("runLegacyWorkspaceDataMigration relocates when migration record targets another namespace", async () => {
    const baseDir = path.join(tempHome, "Papr");
    const wrongHome = resolveOrgNamespaceWorkspacePath("org-run", "ns-wrong");
    const correctHome = resolveOrgNamespaceWorkspacePath("org-run", "ns-correct");
    const userDataPath = resolveOrgNamespaceUserDataPath("org-run", "ns-correct");

    await fs.mkdir(path.join(wrongHome, "documents", "doc-1"), { recursive: true });
    await fs.writeFile(
      path.join(wrongHome, "documents", "doc-1", "readme.md"),
      "hello",
      "utf8",
    );
    await fs.mkdir(correctHome, { recursive: true });

    await fs.writeFile(
      path.join(baseDir, LEGACY_MIGRATION_FILENAME),
      JSON.stringify({
        migratedAt: new Date().toISOString(),
        organizationId: "org-run",
        namespaceId: "ns-wrong",
        targetPaprHome: wrongHome,
        movedPaths: ["documents"],
      }),
      "utf8",
    );

    const result = await runLegacyWorkspaceDataMigration({
      organizationId: "org-run",
      namespaceId: "ns-correct",
      targetPaprHome: correctHome,
      targetUserDataPath: userDataPath,
      allowAutomatedSelfHeal: true,
    });

    expect(result.relocated?.relocatedPaths).toContain("documents");
    await expect(
      fs.access(path.join(correctHome, "documents", "doc-1", "readme.md")),
    ).resolves.toBeUndefined();
  });

  it("consent migration moves all flat ~/Papr root entries into the chosen namespace", async () => {
    const baseDir = path.join(tempHome, "Papr");
    await fs.mkdir(path.join(baseDir, "apps", "app-a"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "apps", "app-a", "index.html"),
      "<html>app</html>",
      "utf8",
    );
    await fs.mkdir(path.join(baseDir, "Jobs", "job-a", "data"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(baseDir, "Jobs", "job-a", "data", "data.db"),
      "sqlite",
      "utf8",
    );
    await fs.writeFile(path.join(baseDir, "papr.db"), "sqlite-root", "utf8");
    await fs.mkdir(path.join(baseDir, "hyperframes"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "hyperframes", "readme.md"),
      "demo",
      "utf8",
    );

    expect(detectUnmigratedFlatPaprContent()).toBe(true);
    expect(listUnmigratedFlatPaprEntries()).toEqual(
      expect.arrayContaining(["apps", "Jobs", "papr.db", "hyperframes"]),
    );

    const pointer = await ensureWorkspaceLayout({
      organizationId: "org-consent",
      namespaceId: "ns-consent",
    });

    const result = await runUserConsentFlatPaprMigration({
      organizationId: "org-consent",
      namespaceId: "ns-consent",
      targetPaprHome: pointer.paprHome,
      targetUserDataPath: pointer.userDataPath,
    });

    expect(result.movedEntries.length).toBeGreaterThan(0);
    expect(listUnmigratedFlatPaprEntries()).toEqual([]);
    await expect(
      fs.access(path.join(pointer.paprHome, "apps", "app-a", "index.html")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(pointer.paprHome, "Jobs", "job-a", "data", "data.db")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(pointer.paprHome, "papr.db")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(pointer.paprHome, "hyperframes", "readme.md")),
    ).resolves.toBeUndefined();
  });

  it("ignores flat ~/Papr/data when it only holds desktop-global cache files", async () => {
    const baseDir = path.join(tempHome, "Papr");
    await fs.mkdir(path.join(baseDir, "data"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "data", "papr-workspace-cache.json"),
      '{"version":1,"workspaces":[]}',
      "utf8",
    );
    await fs.writeFile(
      path.join(baseDir, "data", "papr-auth-pkce.json"),
      "{}",
      "utf8",
    );

    expect(isPaprRootGlobalDataDir(path.join(baseDir, "data"))).toBe(true);
    expect(listUnmigratedFlatPaprEntries()).toEqual([]);
    expect(detectUnmigratedFlatPaprContent()).toBe(false);
  });

  it("still flags flat ~/Papr/data when workspace registry files remain", async () => {
    const baseDir = path.join(tempHome, "Papr");
    await fs.mkdir(path.join(baseDir, "data"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "data", "papr-workspace-cache.json"),
      '{"version":1,"workspaces":[]}',
      "utf8",
    );
    await fs.writeFile(path.join(baseDir, "data", "apps.json"), "[]", "utf8");

    expect(isPaprRootGlobalDataDir(path.join(baseDir, "data"))).toBe(false);
    expect(listUnmigratedFlatPaprEntries()).toEqual(["data"]);
  });

  it("skips automatic flat migration while unmigrated root content remains", async () => {
    const baseDir = path.join(tempHome, "Papr");
    await fs.mkdir(path.join(baseDir, "data"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "data", "settings.json"),
      "{}",
      "utf8",
    );

    const pointer = await ensureWorkspaceLayout({
      organizationId: "org-skip",
      namespaceId: "ns-skip",
    });

    const result = await runLegacyWorkspaceDataMigration({
      organizationId: "org-skip",
      namespaceId: "ns-skip",
      targetPaprHome: pointer.paprHome,
      targetUserDataPath: pointer.userDataPath,
    });

    expect(result.flatLayout).toBeNull();
    expect(result.repairedAppIds).toEqual([]);
    await expect(fs.access(path.join(baseDir, "data", "settings.json"))).resolves
      .toBeUndefined();
  });
});
