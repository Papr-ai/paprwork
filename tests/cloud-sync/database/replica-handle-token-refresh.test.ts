import { expect, test, vi } from "vitest";
import { TursoSyncWorkerCore } from "../../../src/gateway/services/tursoReplica/tursoReplicaSyncWorkerCore.js";

const fake = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../../src/gateway/services/tursoReplica/tursoReplicaConnect.js", () => ({ connectTursoReplica: fake.connect }));

function fakeDb(token: string) {
  return {
    token,
    close: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn(async () => {
      if (token === "rejected") {
        throw new Error("database sync engine error: remote server returned an error: status=401");
      }
      return true;
    }),
  };
}

test("a replica handle reopens when the gateway sends a new token, so pulls recover after a rejected one", async () => {
  fake.connect.mockImplementation(async (o: { authToken: string }) => fakeDb(o.authToken));
  const core = new TursoSyncWorkerCore();
  const spec = { localPath: "/tmp/x/data.db", tursoUrl: "libsql://db", bootstrapIfEmpty: false };

  await expect(core.run({ ...spec, authToken: "rejected", id: "1", op: "pull" })).rejects.toThrow("401");
  // A 401 is a remote error: the handle stays open, holding the rejected token.
  expect(core.openCount()).toBe(1);

  const { result } = await core.run({ ...spec, authToken: "fresh", id: "2", op: "pull" });
  expect(result).toEqual({ pulled: true });
  expect(fake.connect).toHaveBeenCalledTimes(2);
  expect(fake.connect.mock.calls[1][0].authToken).toBe("fresh");

  // Same token again: the open handle is reused.
  await core.run({ ...spec, authToken: "fresh", id: "3", op: "pull" });
  expect(fake.connect).toHaveBeenCalledTimes(2);
  await core.closeAll();
});
