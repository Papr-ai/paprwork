/**
 * Replaces the vault-sync "Gateway wiring" block (which grepped index.ts).
 * Drives the real routes over HTTP and the real key-change wiring.
 */
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerVaultRoutes, wireVaultKeyChanges } from "../src/gateway/routes/vaultRoutes.js";

function fakeVault() {
  return {
    getState: vi.fn(() => ({ status: "idle", lastError: null })),
    pushAllKeys: vi.fn(async () => ({ synced: 2 })),
    pullSharedKeys: vi.fn(async () => 3),
    syncKeyVaultChange: vi.fn(async () => ({ ok: true })),
  };
}

let server: Server;
let base = "";
let vault: ReturnType<typeof fakeVault> | null;

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

beforeEach(async () => {
  vault = fakeVault();
  const app = express();
  app.use(express.json());
  registerVaultRoutes(app, () => vault as never);
  server = await new Promise<Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe("vault routes", () => {
  it("status reports disabled until vault sync is initialized", async () => {
    vault = null;
    expect(await call("GET", "/api/vault/status")).toEqual({
      status: 200, json: { enabled: false, reason: "Vault sync not initialized" },
    });
  });

  it("status merges the live vault state", async () => {
    const { json } = await call("GET", "/api/vault/status");
    expect(json).toEqual({ enabled: true, status: "idle", lastError: null });
  });

  it.each(["/api/vault/push", "/api/vault/pull-shared", "/api/vault/sync-key"])(
    "%s returns 503 before init", async (path) => {
      vault = null;
      expect((await call("POST", path, { name: "K", mode: "update" })).status).toBe(503);
    });

  it("push runs a full push and returns its result", async () => {
    const { status, json } = await call("POST", "/api/vault/push");
    expect(status).toBe(200);
    expect(vault!.pushAllKeys).toHaveBeenCalledTimes(1);
    expect(json).toMatchObject({ success: true, result: { synced: 2 } });
  });

  it("pull-shared returns the upsert count", async () => {
    expect((await call("POST", "/api/vault/pull-shared")).json).toMatchObject({ success: true, upserted: 3 });
  });

  it("push surfaces service errors as 500", async () => {
    vault!.pushAllKeys.mockRejectedValueOnce(new Error("vault down"));
    expect(await call("POST", "/api/vault/push")).toEqual({ status: 500, json: { error: "vault down" } });
  });

  it.each([{}, { name: "K" }, { name: "  ", mode: "delete" }, { name: "K", mode: "rename" }])(
    "sync-key rejects %j with 400", async (body) => {
      expect((await call("POST", "/api/vault/sync-key", body)).status).toBe(400);
      expect(vault!.syncKeyVaultChange).not.toHaveBeenCalled();
    });

  it("sync-key trims the name and forwards owner delete / audience revoke", async () => {
    const body = { name: " OPENAI_API_KEY ", mode: "delete", previousAudience: "org", nextAudience: "private", targetOrgId: "o1" };
    expect((await call("POST", "/api/vault/sync-key", body)).status).toBe(200);
    expect(vault!.syncKeyVaultChange).toHaveBeenCalledWith({
      name: "OPENAI_API_KEY", mode: "delete", previousAudience: "org", nextAudience: "private", targetOrgId: "o1",
    });
  });
});

describe("key change → vault push wiring", () => {
  function wire() {
    let listener: (k?: string) => void = () => {};
    const keys = { onKeyChange: (l: (k?: string) => void) => { listener = l; } };
    const v = { onKeyChanged: vi.fn(async () => {}), scheduleDebouncedPushAll: vi.fn() };
    wireVaultKeyChanges(keys, v as never);
    return { fire: (k?: string) => listener(k), v };
  }

  it("a named key change pushes just that key", () => {
    const { fire, v } = wire();
    fire("OPENAI_API_KEY");
    expect(v.onKeyChanged).toHaveBeenCalledWith("OPENAI_API_KEY");
    expect(v.scheduleDebouncedPushAll).not.toHaveBeenCalled();
  });

  it("a bulk change (no name) schedules one debounced full push", () => {
    const { fire, v } = wire();
    fire();
    expect(v.scheduleDebouncedPushAll).toHaveBeenCalledTimes(1);
    expect(v.onKeyChanged).not.toHaveBeenCalled();
  });

  it("a failed push is logged, not thrown", async () => {
    const { fire, v } = wire();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    v.onKeyChanged.mockRejectedValueOnce(new Error("offline"));
    expect(() => fire("K")).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[Gateway] Vault key push failed:", "offline"));
    warn.mockRestore();
  });
});
