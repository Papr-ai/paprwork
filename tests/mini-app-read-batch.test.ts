import { describe, expect, it, vi } from "vitest";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";

vi.mock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/gateway/services/tursoReplica/tursoReplicaRouting.js")
    >();
  return {
    ...actual,
    shouldUseTursoReplicaForSource: (source: AppDataSource) =>
      source.dbId?.startsWith("replica-") ?? false,
  };
});

import { miniAppReadBatchGroupKey } from "../src/gateway/services/appRuntime/miniAppDbReadBatch.js";

function source(partial: Partial<AppDataSource> & Pick<AppDataSource, "dbPath">): AppDataSource {
  return {
    id: "src-1",
    alias: "test",
    dbId: "replica-1",
    type: "sqlite",
    tables: [],
    linkedAt: new Date().toISOString(),
    ...partial,
  } as AppDataSource;
}

describe("miniAppReadBatchGroupKey", () => {
  it("groups replica sources by dbPath", () => {
    const path = "/tmp/a/data.db";
    const a = source({ dbPath: path, dbId: "replica-a" });
    const b = source({ dbPath: path, alias: "other", dbId: "replica-a" });
    expect(miniAppReadBatchGroupKey(a)).toBe(miniAppReadBatchGroupKey(b));
  });

  it("separates different replica paths", () => {
    const a = source({ dbPath: "/tmp/a/data.db", dbId: "replica-a" });
    const b = source({ dbPath: "/tmp/b/data.db", dbId: "replica-b" });
    expect(miniAppReadBatchGroupKey(a)).not.toBe(miniAppReadBatchGroupKey(b));
  });
});
