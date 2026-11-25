import { expect, test, vi } from "vitest";
import { TursoSyncWorkerCore } from "../../../src/gateway/services/tursoReplica/tursoReplicaSyncWorkerCore.js";

const fake = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../../src/gateway/services/tursoReplica/tursoReplicaConnect.js", () => ({ connectTursoReplica: fake.connect }));

// Mirrors the engine: it calls authToken() before each remote request.
function fakeDb(authToken: () => Promise<string>) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn(async () => {
      if ((await authToken()) === "rejected") {
        throw new Error("database sync engine error: remote server returned an error: status=401");
      }
      return true;
    }),
  };
}

test("a refreshed token reaches the open replica handle, so pulls recover without a reopen", async () => {
  fake.connect.mockImplementation(async (o: { authToken: () => Promise<string> }) => fakeDb(o.authToken));
  const core = new TursoSyncWorkerCore();
  const spec = { localPath: "/tmp/x/data.db", tursoUrl: "libsql://db", bootstrapIfEmpty: false };

  await expect(core.run({ ...spec, authToken: "rejected", id: "1", op: "pull" })).rejects.toThrow("401");
  // A 401 is a remote error: the handle stays open.
  expect(core.openCount()).toBe(1);

  const { result } = await core.run({ ...spec, authToken: "fresh", id: "2", op: "pull" });
  expect(result).toEqual({ pulled: true });
  // Same handle, new token: never reopened.
  expect(fake.connect).toHaveBeenCalledTimes(1);
  await core.closeAll();
});
