import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../utils/cloudApiClient.js", () => ({ cloudApiFetch: (...a: unknown[]) => fetchMock(...a) }));

import { assertOrgAllows, canConnect, clearOrgPolicyCache, getOrgPolicy, OrgPolicyBlockedError } from "./mcpOrgPolicy.js";
import { noticeForEvent } from "../cloudSync/proposalEvents.js";

const policy = (mode: "all" | "approved" | "none", approved: string[] = []) => ({
  mode,
  approved,
  maxShare: "org" as const,
  maxPenAccess: "full" as const,
  setupBy: "admins" as const,
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe("org connection policy", () => {
  beforeEach(() => {
    clearOrgPolicyCache();
    fetchMock.mockReset();
  });

  it("no policy (offline / not deployed) allows everything", () => {
    expect(canConnect(null, "hubspot")).toBe(true);
  });

  it("approved-only allows just the list; none allows nothing", () => {
    expect(canConnect(policy("approved", ["linear"]), "Linear")).toBe(true);
    expect(canConnect(policy("approved", ["linear"]), "hubspot")).toBe(false);
    expect(canConnect(policy("none"), "linear")).toBe(false);
  });

  it("blocks connect for unapproved services and caches the policy", async () => {
    fetchMock.mockResolvedValue(ok({ policy: policy("approved", ["linear"]), isAdmin: false }));
    await expect(assertOrgAllows("linear", "Linear")).resolves.toBeUndefined();
    await expect(assertOrgAllows("hubspot", "HubSpot")).rejects.toBeInstanceOf(OrgPolicyBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the last known policy when the server is briefly unreachable", async () => {
    fetchMock.mockResolvedValueOnce(ok({ policy: policy("none"), isAdmin: true }));
    await getOrgPolicy();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const again = await getOrgPolicy(true);
    expect(again.policy?.mode).toBe("none");
    expect(again.isAdmin).toBe(true);
  });
});

describe("connection request notices", () => {
  const ev = (type: string, detail: Record<string, unknown> = {}) => ({
    id: "e1",
    seq: 1,
    type,
    role: type === "connection.requested" ? "admin" : "requester",
    title: "HubSpot",
    detail: { serverId: "hubspot", ...detail },
    createdAt: "2026-10-08T00:00:00Z",
  });

  it("admins are sent to the Requests list", () => {
    expect(noticeForEvent(ev("connection.requested"))).toMatchObject({
      title: "HubSpot requested",
      openSettings: "connections-requests",
    });
  });

  it("requesters hear the decision, with the reason when declined", () => {
    expect(noticeForEvent(ev("connection.approved"))?.body).toBe("You can connect HubSpot now.");
    expect(noticeForEvent(ev("connection.declined", { reason: "Use Salesforce" }))?.body).toContain('"Use Salesforce"');
  });
});
