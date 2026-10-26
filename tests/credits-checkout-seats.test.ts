import { describe, expect, it, vi, afterEach } from "vitest";
import { countSeatHolders, fetchWorkspaceMembers } from "../src/core/utils/paprWorkspaceTeam";

const m = (id: string, roles: string[]) => ({
  objectId: id,
  user: { objectId: id, email: `${id}@x.com`, allRoles: roles.map((name) => ({ name })) },
});

afterEach(() => vi.unstubAllGlobals());

describe("credits checkout seats", () => {
  it("counts builders only, not members/followers (TruePoint: 8 members → 3 builders)", async () => {
    const members = [
      m("owner", ["owner", "member"]), m("expert", ["expert", "member"]), m("admin", ["admin"]),
      m("a", ["member"]), m("b", ["member"]), m("c", ["follower"]), m("d", ["member"]), m("e", ["member"]),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ members }))));
    const list = await fetchWorkspaceMembers("tok", "ws");
    expect(list).toHaveLength(8);
    expect(countSeatHolders(list)).toBe(3);
  });

  it("never below one seat", () => {
    expect(countSeatHolders([])).toBe(1);
  });
});
