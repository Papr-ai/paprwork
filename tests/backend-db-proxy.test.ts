import express from "express";
import { describe, expect, it } from "vitest";
import {
  createDesktopBackendDbProxyRouter,
  mintBackendDbProxyEnv,
  revokeBackendDbProxyToken,
} from "../src/gateway/services/appRuntime/backendDbProxy.js";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";

const testSource: AppDataSource = {
  id: "src-1",
  type: "sqlite",
  alias: "primary",
  jobId: "job-1",
  dbPath: "/tmp/test.db",
  tables: [],
  linkedAt: "2026-01-01T00:00:00.000Z",
};

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/internal/backend-db",
    createDesktopBackendDbProxyRouter({
      resolveSource: async () => testSource,
      query: async (_appId, _source, sql, params) => ({
        rows: [{ sql, params: params ?? [] }],
        count: 1,
      }),
      write: async () => ({
        changes: 1,
        lastInsertRowid: 42,
      }),
    }),
  );
  return app;
}

async function listen(app: express.Express): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected server to bind to a port");
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/internal/backend-db`,
        close: () => server.close(),
      });
    });
  });
}

describe("backendDbProxy", () => {
  it("mints proxy env and revokes token", () => {
    const env = mintBackendDbProxyEnv({
      appId: "app-1",
      sourceId: "primary",
      proxyBaseUrl: "http://127.0.0.1:18789",
    });
    expect(env.PAPR_DB_MODE).toBe("proxy");
    expect(env.PAPR_DB_PROXY_URL).toBe("http://127.0.0.1:18789/internal/backend-db");
    expect(env.PAPR_DB_PROXY_TOKEN).toMatch(/^[a-f0-9]+$/);
    revokeBackendDbProxyToken(env.PAPR_DB_PROXY_TOKEN);
  });

  it("routes query with bearer token", async () => {
    const app = createTestApp();
    const { baseUrl, close } = await listen(app);
    const env = mintBackendDbProxyEnv({
      appId: "app-1",
      proxyBaseUrl: baseUrl.replace(/\/internal\/backend-db$/, ""),
    });

    try {
      const res = await fetch(`${baseUrl}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.PAPR_DB_PROXY_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql: "SELECT 1", params: [] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: Array<{ sql: string }>; count: number };
      expect(body.count).toBe(1);
      expect(body.rows[0]?.sql).toBe("SELECT 1");
    } finally {
      revokeBackendDbProxyToken(env.PAPR_DB_PROXY_TOKEN);
      close();
    }
  });

  it("returns write lastInsertRowid", async () => {
    const app = createTestApp();
    const { baseUrl, close } = await listen(app);
    const env = mintBackendDbProxyEnv({
      appId: "app-1",
      proxyBaseUrl: baseUrl.replace(/\/internal\/backend-db$/, ""),
    });

    try {
      const res = await fetch(`${baseUrl}/write`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.PAPR_DB_PROXY_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sql: "INSERT INTO items (name) VALUES (?)",
          params: ["test"],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { changes: number; lastInsertRowid: number };
      expect(body.changes).toBe(1);
      expect(body.lastInsertRowid).toBe(42);
    } finally {
      revokeBackendDbProxyToken(env.PAPR_DB_PROXY_TOKEN);
      close();
    }
  });

  it("rejects missing token", async () => {
    const app = createTestApp();
    const { baseUrl, close } = await listen(app);

    try {
      const res = await fetch(`${baseUrl}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1" }),
      });
      expect(res.status).toBe(401);
    } finally {
      close();
    }
  });
});
