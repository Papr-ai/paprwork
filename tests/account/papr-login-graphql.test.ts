import { describe, expect, it } from "vitest";
import {
  GET_WORKSPACE_ORG_CLAIM_STATE,
  LINK_ORG_SUBSCRIPTION,
  UPDATE_WORKSPACE_ORG,
  assertUpdateWorkspaceOrgMutation,
  readSubscriptionPointerId,
} from "../../src/core/papr/paprLoginGraphql.js";

describe("UPDATE_WORKSPACE_ORG GraphQL mutation", () => {
  it("selects workSpace on UpdateWorkSpacePayload", () => {
    expect(() => assertUpdateWorkspaceOrgMutation(UPDATE_WORKSPACE_ORG)).not.toThrow();
    expect(UPDATE_WORKSPACE_ORG).toContain("workSpace {");
    expect(UPDATE_WORKSPACE_ORG).not.toMatch(/updateWorkSpace[\s\S]*\bworkspace\s*\{/);
  });

  it("rejects the old invalid workspace selection", () => {
    const invalid = UPDATE_WORKSPACE_ORG.replace("workSpace {", "workspace {");
    expect(() => assertUpdateWorkspaceOrgMutation(invalid)).toThrow(/workSpace/i);
  });
});

describe("workspace subscription linking (duplicate-org billing fix)", () => {
  it("claim-state query reads the workspace subscription so a new org can link it", () => {
    expect(GET_WORKSPACE_ORG_CLAIM_STATE).toMatch(/workSpace\(id: \$workspaceId\)[\s\S]*\bsubscription\b/);
  });

  it("LINK_ORG_SUBSCRIPTION links Organization.subscription", () => {
    expect(LINK_ORG_SUBSCRIPTION).toContain("updateOrganization(");
    expect(LINK_ORG_SUBSCRIPTION).toContain("subscription: { link: $subscriptionId }");
  });

  it("readSubscriptionPointerId accepts pointer objects and JSON strings", () => {
    expect(
      readSubscriptionPointerId({ __type: "Pointer", className: "Subscription", objectId: "0n6FW7ZrFa" }),
    ).toBe("0n6FW7ZrFa");
    expect(readSubscriptionPointerId('{"objectId":"abc"}')).toBe("abc");
    expect(readSubscriptionPointerId(null)).toBeUndefined();
    expect(readSubscriptionPointerId("not json")).toBeUndefined();
    expect(readSubscriptionPointerId({ objectId: "  " })).toBeUndefined();
  });
});
