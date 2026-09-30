import { describe, expect, it, vi, afterEach } from "vitest";
import {
  assertMiniAppMembersAccess,
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
