import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * memory#530: session reads must name the same user the message writes do, or the
 * memory server answers from the API key owner's Chat (2 of 85 messages).
 */
vi.mock("../../../src/gateway/utils/memoryScopeResolver.js", () => ({
  getMemoryScopeContext: vi.fn(() => ({ userId: "cqH1mR0IqH", namespaceId: "ns1" })),
}));

const { paprSessionUserQuery, withPaprSessionUser } = await import(
  "../../../src/gateway/services/storage/paprSessionScope.js"
);
const scope = await import("../../../src/gateway/utils/memoryScopeResolver.js");
const { buildPaprSyncStoreBody } = await import(
  "../../../src/gateway/services/storage/paprSyncPayload.js"
);

afterEach(() => vi.mocked(scope.getMemoryScopeContext).mockClear());

describe("paprSessionScope", () => {
  test("adds the signed-in Papr user to session reads", () => {
    expect(paprSessionUserQuery()).toEqual({ user_id: "cqH1mR0IqH" });
    expect(withPaprSessionUser({ limit: 1, skip: 0 })).toEqual({
      limit: 1,
      skip: 0,
      user_id: "cqH1mR0IqH",
    });
  });

  test("read user matches the user messages.store files the message under", () => {
    const body = buildPaprSyncStoreBody({
      chatId: "a7daa280-28f1-4182-9b1b-a0440ede52b2",
      message: {
        id: "m1",
        chat_id: "a7daa280-28f1-4182-9b1b-a0440ede52b2",
        role: "user",
        content: "hi",
        timestamp: new Date().toISOString(),
      } as never,
      userId: "cqH1mR0IqH",
    });
    expect(withPaprSessionUser().user_id).toBe(body.user_id);
  });

  test("sends nothing when no Papr user is signed in (server keeps its default)", () => {
    vi.mocked(scope.getMemoryScopeContext).mockReturnValueOnce({ userId: undefined } as never);
    expect(paprSessionUserQuery()).toEqual({});
    expect(paprSessionUserQuery("  ")).toEqual({});
    expect(withPaprSessionUser({ limit: 5 }, "")).toEqual({ limit: 5 });
  });
});
