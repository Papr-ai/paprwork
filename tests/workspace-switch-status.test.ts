import { describe, expect, it } from "vitest";
import { isGatewayWorkspaceSwitchComplete } from "../ui/lib/workspaceSwitchStatus";

describe("isGatewayWorkspaceSwitchComplete", () => {
  it("ignores idle status before a switch starts", () => {
    expect(
      isGatewayWorkspaceSwitchComplete(
        { active: false, phase: "idle" },
        {
          targetOrganizationId: "org-a",
          targetNamespaceId: "ns-a",
        },
      ),
    ).toBe(false);
  });

  it("ignores complete status for a different workspace", () => {
    expect(
      isGatewayWorkspaceSwitchComplete(
        {
          active: false,
          phase: "complete",
          organizationId: "org-old",
          namespaceId: "ns-old",
        },
        {
          targetOrganizationId: "org-new",
          targetNamespaceId: "ns-new",
        },
      ),
    ).toBe(false);
  });

  it("accepts complete status when target workspace matches", () => {
    expect(
      isGatewayWorkspaceSwitchComplete(
        {
          active: false,
          phase: "complete",
          organizationId: "org-new",
          namespaceId: "ns-new",
        },
        {
          targetOrganizationId: "org-new",
          targetNamespaceId: "ns-new",
        },
      ),
    ).toBe(true);
  });

  it("accepts complete status without a target filter", () => {
    expect(
      isGatewayWorkspaceSwitchComplete({
        active: false,
        phase: "complete",
      }),
    ).toBe(true);
  });
});
