import { describe, it, expect, beforeEach, vi } from "vitest";

// The add path resolves user/namespace scope from settings; stub it so these
// tests exercise upsert logic only.
vi.mock("../src/gateway/utils/memoryScopeResolver.js", () => ({
  paprMemoryScopeSpread: vi.fn().mockResolvedValue({ user_id: "u1", external_user_id: "u1" }),
}));
vi.mock("../src/gateway/utils/paprMemoryPolicy.js", () => ({
  buildCodeIndexAddPolicy: vi.fn().mockReturnValue({}),
}));

import {
  CodeSummaryMemoryStore,
  isMemoryNotFound,
} from "../src/gateway/services/storage/CodeSummaryMemoryStore.js";

function makeClient(over: {
  update?: ReturnType<typeof vi.fn>;
  add?: ReturnType<typeof vi.fn>;
  del?: ReturnType<typeof vi.fn>;
} = {}) {
  const update = over.update ?? vi.fn().mockResolvedValue({ id: "mem-1" });
  const add = over.add ?? vi.fn().mockResolvedValue({ id: "mem-new" });
  const del = over.del ?? vi.fn().mockResolvedValue({});
  return {
    client: { memory: { update, add, delete: del } },
    update,
    add,
    delete: del,
  };
}

const summaryInput = {
  content: "updated summary text",
  filePath: "/Users/x/Papr/apps/app-1/db.ts",
  fileName: "db.ts",
  projectId: "app-1",
  projectType: "mini_app" as const,
  language: "TypeScript",
  contentHash: "abc123",
};

describe("CodeSummaryMemoryStore upsert", () => {
  beforeEach(() => vi.clearAllMocks());

  it("UPDATES in place when a memory id is known — never adds", async () => {
    const { client, update, add, delete: del } = makeClient();
    const store = new CodeSummaryMemoryStore(client as never, "schema-1");

    const id = await store.upsertFileSummary({
      ...summaryInput,
      previousMemoryId: "mem-1",
    });

    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]![0]).toBe("mem-1");
    expect((update.mock.calls[0]![1] as { content: string }).content).toBe(
      "updated summary text",
    );
    // The two calls that created duplicates must not happen.
    expect(add).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    // Id is stable across re-index, so the tracker keeps pointing at one doc.
    expect(id).toBe("mem-1");
  });

  it("does NOT fall back to add when update fails with 500", async () => {
    // THE anti-duplication guard. The old code caught the delete failure and
    // added anyway, leaving two documents sharing one memoryId. A transient
    // server error must surface, not silently duplicate.
    const update = vi.fn().mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 }),
    );
    const { client, add } = makeClient({ update });
    const store = new CodeSummaryMemoryStore(client as never, "schema-1");

    await expect(
      store.upsertFileSummary({ ...summaryInput, previousMemoryId: "mem-1" }),
    ).rejects.toThrow("boom");

    expect(add).not.toHaveBeenCalled();
  });

  it("falls back to add ONLY on a genuine 404", async () => {
    const update = vi.fn().mockRejectedValue(
      Object.assign(new Error("gone"), { status: 404 }),
    );
    const { client, add } = makeClient({ update });
    const store = new CodeSummaryMemoryStore(client as never, "schema-1");

    const id = await store.upsertFileSummary({
      ...summaryInput,
      previousMemoryId: "stale-id",
    });

    expect(add).toHaveBeenCalledOnce();
    expect(id).toBe("mem-new");
  });

  it("adds when no previous memory id exists (first index)", async () => {
    const { client, update, add } = makeClient();
    const store = new CodeSummaryMemoryStore(client as never, "schema-1");

    const id = await store.upsertFileSummary(summaryInput);

    expect(update).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledOnce();
    expect(id).toBe("mem-new");
  });

  it("updates project overviews in place too", async () => {
    const { client, update, add } = makeClient();
    const store = new CodeSummaryMemoryStore(client as never, "schema-1");

    await store.upsertProjectOverview({
      content: "overview",
      projectId: "app-1",
      projectType: "mini_app",
      projectName: "App One",
      fileCount: 12,
      previousMemoryId: "mem-ov",
    });

    expect(update.mock.calls[0]![0]).toBe("mem-ov");
    expect(add).not.toHaveBeenCalled();
  });
});

describe("isMemoryNotFound", () => {
  it("recognises 404 from status and statusCode", () => {
    expect(isMemoryNotFound({ status: 404 })).toBe(true);
    expect(isMemoryNotFound({ statusCode: 404 })).toBe(true);
  });

  it("treats everything else as present — the safe default", () => {
    // Returning true here would let a transient failure become a duplicate.
    expect(isMemoryNotFound({ status: 500 })).toBe(false);
    expect(isMemoryNotFound({ status: 429 })).toBe(false);
    expect(isMemoryNotFound(new Error("network"))).toBe(false);
    expect(isMemoryNotFound(null)).toBe(false);
    expect(isMemoryNotFound(undefined)).toBe(false);
  });
});
