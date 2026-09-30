import { describe, expect, it, vi, afterEach } from "vitest";
import {
  httpStatusForDbRouteError,
  httpStatusForMiniAppDbQueryError,
} from "../src/gateway/services/tursoReplica/replicaSchemaQueryErrorMessage.js";
import { isReplicaRemoteHttpError } from "../src/gateway/services/tursoReplica/tursoReplicaErrors.js";
import { retryTransientTursoStatus } from "../src/gateway/services/tursoReplica/tursoReplicaConnect.js";

vi.mock("@tursodatabase/sync", () => ({ connect: vi.fn() }));

describe("transient replica DB errors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps sync/lock/remote failures to 503 and keeps explicit statuses", () => {
    for (const msg of [
      "sync engine operation failed: remote server returned an error: status=500",
      "database is locked",
      "sync_engine is busy",
      "replica operation timed out after 30000ms",
    ]) {
      expect(httpStatusForMiniAppDbQueryError(msg)).toBe(503);
    }
    expect(httpStatusForDbRouteError(Object.assign(new Error("x"), { status: 400 }))).toBe(400);
    expect(httpStatusForDbRouteError(new Error("UNIQUE constraint failed"))).toBe(500);
    expect(httpStatusForDbRouteError(new Error("database is locked"))).toBe(503);
  });

  it("classifies remote HTTP/network failures, not local damage", () => {
    expect(isReplicaRemoteHttpError(new Error("remote server returned an error: status=500"))).toBe(true);
    expect(isReplicaRemoteHttpError(new Error("fetch error: TypeError: fetch failed"))).toBe(true);
    expect(isReplicaRemoteHttpError(new Error("short read on WAL frame at offset 1"))).toBe(false);
    expect(isReplicaRemoteHttpError(new Error("database is locked"))).toBe(false);
  });

  it("retries a Turso 5xx once and never retries thrown fetch errors", async () => {
    const ok = new Response("ok", { status: 200 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);
    expect((await retryTransientTursoStatus("https://x/info")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const offline = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", offline);
    await expect(retryTransientTursoStatus("https://x/info")).rejects.toThrow("fetch failed");
    expect(offline).toHaveBeenCalledTimes(1);

    const four = vi.fn().mockResolvedValue(new Response("no", { status: 401 }));
    vi.stubGlobal("fetch", four);
    expect((await retryTransientTursoStatus("https://x/info")).status).toBe(401);
    expect(four).toHaveBeenCalledTimes(1);
  });
});
