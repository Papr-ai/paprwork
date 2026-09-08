import { afterEach, describe, expect, it, vi } from "vitest";

const healReplicaSchemaDriftMock = vi.hoisted(() =>
  vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }),
);

vi.mock("../src/gateway/services/tursoReplica/tursoReplicaSchemaDriftHeal.js", () => ({
  healReplicaSchemaDrift: healReplicaSchemaDriftMock,
}));

import {
  resetReplicaSchemaDriftSchedulerForTests,
  scheduleReplicaSchemaDriftHeal,
} from "../src/gateway/services/tursoReplica/tursoReplicaSchemaDriftScheduler.js";

describe("tursoReplicaSchemaDriftScheduler", () => {
  afterEach(() => {
    resetReplicaSchemaDriftSchedulerForTests();
    healReplicaSchemaDriftMock.mockClear();
  });

  it("dedupes concurrent heal requests for the same db path", async () => {
    const source = {
      id: "db-1",
      type: "sqlite" as const,
      dbId: "db-1",
      alias: "sync",
      dbPath: "/tmp/test/data.db",
      tables: [],
      linkedAt: "2026-01-01T00:00:00.000Z",
    };

    scheduleReplicaSchemaDriftHeal(source);
    scheduleReplicaSchemaDriftHeal(source);
    scheduleReplicaSchemaDriftHeal(source);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(healReplicaSchemaDriftMock).toHaveBeenCalledTimes(1);
  });

  it("does not schedule when dbPath is missing", async () => {
    scheduleReplicaSchemaDriftHeal({
      id: "db-1",
      type: "sqlite",
      alias: "sync",
      tables: [],
      linkedAt: "2026-01-01T00:00:00.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(healReplicaSchemaDriftMock).not.toHaveBeenCalled();
  });
});
