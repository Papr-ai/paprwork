/**
 * Job DB proxy: a job may name a database it is allowed to write by dbId,
 * registry label, or its linked app's alias — and nothing else.
 */
import { describe, expect, it, vi } from "vitest";
import {
  matchAllowedDbIds,
  resolveDesktopProxySource,
  type BackendDbProxySession,
  type DesktopBackendDbProxyDeps,
} from "../../../src/gateway/services/appRuntime/backendDbProxy.js";

const RELEASE = "db-7d873f7a";
const METRICS = "db-metrics01";

function deps(over: Partial<DesktopBackendDbProxyDeps> = {}) {
  const labels: Record<string, string> = { [RELEASE]: "Release Desk", [METRICS]: "Metrics" };
  const d: DesktopBackendDbProxyDeps = {
    resolveSource: vi.fn(async (_app, sourceId) => {
      throw Object.assign(new Error(`app lookup: unknown ${sourceId}`), { status: 404 });
    }),
    resolveRegistrySource: vi.fn(async (dbId) => ({
      id: dbId, type: "sqlite" as const, dbId, alias: labels[dbId] ?? dbId,
      dbPath: `/tmp/${dbId}.db`, tables: [], linkedAt: "",
    })),
    registryLabel: async (dbId) => labels[dbId] ?? null,
    appDbAliases: async () => [{ dbId: RELEASE, alias: "release" }],
    query: vi.fn(), write: vi.fn(),
    ...over,
  };
  return d;
}

const session = (s: Partial<BackendDbProxySession>): BackendDbProxySession => ({
  appId: "app-1", sourceId: "Release Desk", allowedDbIds: [RELEASE], expiresAt: Date.now() + 1e6, ...s,
});
const resolve = (d: DesktopBackendDbProxyDeps, s: BackendDbProxySession, name?: string) =>
  resolveDesktopProxySource(d, s, name, "SELECT 1", "read");

describe("job DB proxy source resolution", () => {
  it.each([["release"], ["Release Desk"], [RELEASE], [undefined]])(
    "resolves %s to the job's database",
    async (name) => {
      const d = deps();
      await expect(resolve(d, session({}), name)).resolves.toMatchObject({ dbId: RELEASE });
      expect(d.resolveSource).not.toHaveBeenCalled();
    },
  );

  it("standalone job resolves by label or id, and rejects other names", async () => {
    const d = deps();
    const s = session({ appId: "__standalone__" });
    await expect(resolve(d, s, "Release Desk")).resolves.toMatchObject({ dbId: RELEASE });
    await expect(resolve(d, s, "nope")).rejects.toMatchObject({ status: 400 });
  });

  it("never reaches a database outside the job's allowed list", async () => {
    const d = deps({ appDbAliases: async () => [{ dbId: "db-other", alias: "other" }] });
    await expect(resolve(d, session({}), "db-other")).rejects.toThrow(/app lookup/);
    expect(d.resolveRegistrySource).not.toHaveBeenCalled();
  });

  it("unknown name on an app job falls back to the app's own sources (unchanged behaviour)", async () => {
    const d = deps();
    await expect(resolve(d, session({}), "something-else")).rejects.toThrow(/app lookup/);
    expect(d.resolveSource).toHaveBeenCalledWith("app-1", "something-else", "SELECT 1", "read");
  });

  it("reaches the second of two databases", async () => {
    const d = deps();
    const s = session({ allowedDbIds: [RELEASE, METRICS] });
    await expect(resolve(d, s, "Metrics")).resolves.toMatchObject({ dbId: METRICS });
    await expect(resolve(d, s, "release")).resolves.toMatchObject({ dbId: RELEASE });
  });

  it("refuses an ambiguous name instead of guessing", async () => {
    const d = deps({
      appDbAliases: async () => [
        { dbId: RELEASE, alias: "shared" },
        { dbId: METRICS, alias: "shared" },
      ],
    });
    const s = session({ allowedDbIds: [RELEASE, METRICS] });
    await expect(resolve(d, s, "shared")).rejects.toMatchObject({ status: 409 });
    expect(d.resolveRegistrySource).not.toHaveBeenCalled();
  });

  it("sessions without allowedDbIds keep the old paths", async () => {
    const d = deps();
    await expect(resolve(d, session({ allowedDbIds: undefined }), "release")).rejects.toThrow(/app lookup/);
    expect(d.resolveSource).toHaveBeenCalled();
  });

  it("matchAllowedDbIds matches id, label and alias only", () => {
    const allowed = [{ dbId: RELEASE, label: "Release Desk", appAliases: ["release"] }];
    expect(matchAllowedDbIds(" release ", allowed)).toEqual([RELEASE]);
    expect(matchAllowedDbIds("Release", allowed)).toEqual([]);
  });
});
