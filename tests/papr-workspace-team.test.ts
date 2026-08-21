import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveWorkspaceIdForNamespace } from "../src/core/utils/paprWorkspaceTeam.js";

describe("resolveWorkspaceIdForNamespace", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not request invalid Organization.workSpace field (schema is workspace only)", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      expect(body.query).not.toContain("workSpace");
      expect(body.query).toContain("workspace { objectId }");
      return new Response(
        JSON.stringify({
          data: {
            namespace: {
              objectId: "8Pu0Oc6pIh",
              organization: { workspace: { objectId: "NOxtJsAPHQ" } },
            },
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveWorkspaceIdForNamespace("session", "8Pu0Oc6pIh");
    expect(result).toBe("NOxtJsAPHQ");
  });

  it("returns null when GraphQL validation fails (legacy broken query shape)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          errors: [
            {
              message:
                'Cannot query field "workSpace" on type "Organization". Did you mean "workspace"?',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveWorkspaceIdForNamespace("session", "8Pu0Oc6pIh");
    expect(result).toBeNull();
  });
});
