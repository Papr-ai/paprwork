/**
 * Replaces the old version, which checked a hand-written path list against
 * itself. This runs the real contract check against a fake memory server's
 * OpenAPI, so it fails if the check stops catching a missing route.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs helper, no types
import { SYNC_V3_OPENAPI_PATH_PATTERNS as P, verifySyncV3MemoryRoutes } from "../scripts/lib/syncV3MemoryContract.mjs";

type Pattern = { id: string; label: string; test: (p: string) => boolean };
const PATTERNS = P as Pattern[];
/** "POST /v1/cloud/apps/{appId}/repo" → "/v1/cloud/apps/{app_id}/repo" (FastAPI style). */
const pathOf = (r: Pattern) => r.label.split(" ")[1].replace(/\{[^}]+\}/g, "{app_id}");

let server: Server | null = null;
async function memoryWith(paths: string[], status = 200): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ paths: Object.fromEntries(paths.map((p) => [p, {}])) }));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
}
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

describe("sync v3 memory contract check", () => {
  it("every pattern's own label path satisfies it (labels stay honest)", () => {
    for (const r of PATTERNS) expect(r.test(pathOf(r)), r.label).toBe(true);
  });

  it("passes when the server exposes every route", async () => {
    const result = await verifySyncV3MemoryRoutes(await memoryWith(PATTERNS.map(pathOf)));
    expect(result.ok).toBe(true);
  });

  it("names exactly the route that is missing", async () => {
    const [dropped, ...rest] = PATTERNS;
    const result = await verifySyncV3MemoryRoutes(await memoryWith(rest.map(pathOf)));
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([{ id: dropped.id, label: dropped.label }]);
  });

  it("legacy namespace repo routes don't count as the app repo route", async () => {
    const paths = PATTERNS.filter((r) => r.id !== "app_repo_get").map(pathOf);
    const result = await verifySyncV3MemoryRoutes(await memoryWith([...paths, "/v1/cloud/repos/init", "/v1/cloud/apps/{app_id}/repo/ensure"]));
    expect(result.missing?.map((m: { id: string }) => m.id)).toEqual(["app_repo_get"]);
  });

  it("reports every route missing when OpenAPI can't be fetched", async () => {
    const result = await verifySyncV3MemoryRoutes(await memoryWith([], 502));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/OpenAPI fetch 502/);
    expect(result.missing).toHaveLength(PATTERNS.length);
  });
});
