/**
 * Sandbox loopback API: /api/db/* and the papr_db proxy route to cloud-direct
 * sources, so `curl localhost:18789/...` behaves like desktop in cloud runs.
 */
import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("sandbox local API", () => {
  let tmp: string;
  const appId = "app-glow";
  const dbId = "db-sbx";
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-sbx-api-"));
    process.env.PAPR_HOME = tmp;
    fs.mkdirSync(path.join(tmp, "apps", appId), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "apps", appId, "data-sources.json"),
      JSON.stringify({ sources: [{ id: `${dbId}:glow`, type: "sqlite", dbId, alias: "glow", dbPath: "", tables: [], linkedAt: "" }] }),
    );
    const record = { dbId, localPath: path.join(tmp, "nope.db"), tursoShortName: "d-sbx", label: "glow", isolation: "shared", status: "active", syncMode: "cloud-direct", createdAt: "", updatedAt: "" };
    vi.doMock("../../src/core/utils/paprRoot.js", async (orig) => ({
      ...(await orig<object>()),
      getPaprRoot: () => tmp,
    }));
    vi.doMock("../../src/gateway/services/DatabaseRegistryService.js", () => ({
      initializeDatabaseRegistry: async () => ({}),
      getDatabaseRegistryService: () => ({ getById: (id: string) => (id === dbId ? record : undefined), getByPath: () => undefined }),
      resolveTursoDatabaseNameForSource: () => "d-sbx",
      tursoNameForRecord: () => "d-sbx",
    }));
  });

  afterEach(async () => {
    const cd = await import("../../src/gateway/services/cloudDirect/cloudDirectDb.js");
    cd.setCloudDirectClientFactoryForTests(null);
    vi.doUnmock("../../src/core/utils/paprRoot.js");
    vi.doUnmock("../../src/gateway/services/DatabaseRegistryService.js");
    vi.resetModules();
    process.env = { ...originalEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("serves /api/db/query and /api/db/write against the cloud primary", async () => {
    const cd = await import("../../src/gateway/services/cloudDirect/cloudDirectDb.js");
    const primary = `file:${path.join(tmp, "primary.db")}`;
    cd.setCloudDirectClientFactoryForTests(async () => createClient({ url: primary }));
    const seed = createClient({ url: primary });
    await seed.executeMultiple("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT); INSERT INTO tasks VALUES ('a','pending');");
    seed.close();

    const { createSandboxLocalApi } = await import("../../src/gateway/services/cloudAgentGateway/sandboxLocalApi.js");
    const server = createSandboxLocalApi().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown) =>
      fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const w = await post("/api/db/write", { appId, sourceId: "glow", sql: "UPDATE tasks SET status = ? WHERE id = ?", params: ["working", "a"] });
      expect(w.status).toBe(200);
      expect((await w.json()).changes).toBe(1);
      const q = await post("/api/db/query", { appId, sourceId: "glow", sql: "SELECT status FROM tasks" });
      expect((await q.json()).rows).toEqual([{ status: "working" }]);
      const bad = await post("/api/db/query", { appId, sql: "DELETE FROM tasks" });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      const unknown = await post("/api/app/backend/nope", { appId });
      expect(unknown.status).toBeGreaterThanOrEqual(400);
    } finally {
      server.close();
    }
  });
});

describe("focus context view line", () => {
  it("web + installed reminds local tools; web-only says not installed; local says local", async () => {
    const { formatAgentFocusContext } = await import("../../src/gateway/services/agent/focusContextFormatter.js");
    const base = { appId: "a1", title: "Glow", files: ["app.ts"] };
    const web = formatAgentFocusContext({ activeApp: { ...base, surface: "web", installed: true } })!;
    expect(web).toContain("web version");
    expect(web).toContain("also installed locally");
    const webOnly = formatAgentFocusContext({ activeApp: { ...base, surface: "web", installed: false } })!;
    expect(webOnly).toContain("Not installed on this desktop");
    const local = formatAgentFocusContext({ activeApp: { ...base, surface: "local", installed: true } })!;
    expect(local).toContain("local preview");
    // Stable text per state (prompt-cache friendly).
    expect(formatAgentFocusContext({ activeApp: { ...base, surface: "web", installed: true } })).toBe(web);
  });

  it("merge keeps the UI surface and the server's installed/files", async () => {
    const { mergeUiAndServerFocus } = await import("../../src/gateway/services/agent/focusContextFormatter.js");
    const merged = mergeUiAndServerFocus(
      { activeApp: { appId: "a1", title: "Glow", surface: "web" } },
      { activeApp: { appId: "a1", title: "Glow", files: ["x.ts"], installed: true } },
    );
    expect(merged?.activeApp).toMatchObject({ surface: "web", installed: true, files: ["x.ts"] });
  });
});
