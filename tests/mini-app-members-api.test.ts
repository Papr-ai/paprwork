import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import {
  assertMiniAppMembersAccess,
  clearMiniAppMembersCache,
  MEMBERS_FRESH_MS,
  MEMBERS_STALE_MS,
  canListMiniAppMembers,
  listMiniAppMembers,
  MiniAppMembersError,
} from "../src/gateway/services/appRuntime/miniAppMembers.js";
import type { AppAccessContext } from "../src/gateway/services/appRuntime/types.js";

const teamAccess: AppAccessContext = {
  orgId: "org-1",
  namespaceId: "ns-1",
  userId: "user-1",
  appId: "app-1",
  mode: "team",
  canRead: true,
  canWrite: true,
};

describe("miniAppMembers access control", () => {
  it("requires sign-in and canRead", () => {
    expect(canListMiniAppMembers(false, teamAccess)).toBe(false);
    expect(canListMiniAppMembers(true, null)).toBe(false);
    expect(canListMiniAppMembers(true, { ...teamAccess, canRead: false })).toBe(
      false,
    );
    expect(canListMiniAppMembers(true, teamAccess)).toBe(true);
  });

  it("assertMiniAppMembersAccess throws 401 when logged out", () => {
    expect(() => assertMiniAppMembersAccess(false, teamAccess)).toThrow(
      MiniAppMembersError,
    );
    try {
      assertMiniAppMembersAccess(false, teamAccess);
    } catch (err) {
      expect(err).toMatchObject({ status: 401 });
    }
  });

  it("assertMiniAppMembersAccess throws 403 without read access", () => {
    try {
      assertMiniAppMembersAccess(true, { ...teamAccess, canRead: false });
    } catch (err) {
      expect(err).toMatchObject({ status: 403 });
    }
  });
});

describe("listMiniAppMembers", () => {
  beforeEach(() => clearMiniAppMembersCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns mapped members when only workspace id is provided", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/api/workspace/members")) {
        return new Response(
          JSON.stringify({
            members: [
              {
                objectId: "membership-1",
                user: {
                  objectId: "user-abc",
                  email: "dev@papr.ai",
                  displayName: "Dev User",
                  allRoles: [{ name: "admin" }],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listMiniAppMembers({
      sessionToken: "session-token",
      workspaceId: "ws-123",
      workspaceName: "Acme",
    });

    expect(result).toMatchObject({
      workspaceId: "ws-123",
      workspaceName: "Acme",
      members: [
        {
          userId: "user-abc",
          email: "dev@papr.ai",
          displayName: "Dev User",
          role: "admin",
        },
      ],
    });
  });

  it("prefers namespace-resolved workspace id over stale explicit workspace id", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              namespace: {
                objectId: "ns-new",
                organization: {
                  workspace: { objectId: "ws-from-ns" },
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      if (href.includes("/api/workspace/members")) {
        const parsed = new URL(href);
        expect(parsed.searchParams.get("workspaceId")).toBe("ws-from-ns");
        expect(init?.headers).toMatchObject({
          "X-Parse-Session-Token": "session-token",
        });
        return new Response(JSON.stringify({ members: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listMiniAppMembers({
      sessionToken: "session-token",
      workspaceId: "ws-stale-from-previous-switch",
      namespaceId: "ns-new",
    });

    expect(result.workspaceId).toBe("ws-from-ns");
    expect(result.namespaceId).toBe("ns-new");
  });

  it("resolves workspace from namespace when workspace id omitted", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              namespace: {
                objectId: "ns-1",
                organization: {
                  workspace: { objectId: "ws-from-ns" },
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      if (href.includes("/api/workspace/members")) {
        expect(init?.headers).toMatchObject({
          "X-Parse-Session-Token": "session-token",
        });
        return new Response(JSON.stringify({ members: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listMiniAppMembers({
      sessionToken: "session-token",
      namespaceId: "ns-1",
    });

    expect(result.workspaceId).toBe("ws-from-ns");
    expect(result.namespaceId).toBe("ns-1");
    expect(result.members).toEqual([]);
  });

  it("rejects missing session token", async () => {
    await expect(
      listMiniAppMembers({ sessionToken: "  ", workspaceId: "ws-1" }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("listMiniAppMembers cache", () => {
  beforeEach(() => clearMiniAppMembersCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubRoster() {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          members: [{ objectId: `m-${calls}`, user: { objectId: `user-${calls}`, email: `u${calls}@papr.ai`, displayName: `U${calls}` } }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const input = (token = "tok-a") => ({ sessionToken: token, workspaceId: "ws-1" });

  it("serves a fresh roster without a second cloud call", async () => {
    const fetchMock = stubRoster();
    let t = 1_000;
    const a = await listMiniAppMembers(input(), () => t);
    t += MEMBERS_FRESH_MS - 1;
    const b = await listMiniAppMembers(input(), () => t);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the stale roster instantly and refreshes once in the background", async () => {
    const fetchMock = stubRoster();
    let t = 1_000;
    const a = await listMiniAppMembers(input(), () => t);
    t += MEMBERS_FRESH_MS + 1;
    const [b, c] = await Promise.all([listMiniAppMembers(input(), () => t), listMiniAppMembers(input(), () => t)]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    const d = await listMiniAppMembers(input(), () => t);
    expect(d.members[0]?.userId).toBe("user-2");
  });

  it("refetches synchronously once the roster is past the stale window", async () => {
    const fetchMock = stubRoster();
    let t = 1_000;
    await listMiniAppMembers(input(), () => t);
    t += MEMBERS_STALE_MS + 1;
    const b = await listMiniAppMembers(input(), () => t);
    expect(b.members[0]?.userId).toBe("user-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never shares a cached roster across session tokens", async () => {
    const fetchMock = stubRoster();
    await listMiniAppMembers(input("tok-a"));
    const other = await listMiniAppMembers(input("tok-b"));
    expect(other.members[0]?.userId).toBe("user-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(listMiniAppMembers(input())).rejects.toThrow();
    const fetchMock = stubRoster();
    await expect(listMiniAppMembers(input())).resolves.toMatchObject({ workspaceId: "ws-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
