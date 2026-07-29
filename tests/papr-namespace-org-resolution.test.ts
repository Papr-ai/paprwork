import { describe, expect, it } from "vitest";
import { resolveNamespaceOrganizationId } from "../src/electron/ipc/paprLogin.js";

describe("resolveNamespaceOrganizationId", () => {
  const developerOrgId = "Y8D4H7Yp3Z";
  const thinOwnedOrg = {
    organizationId: "De6SRb7yNd",
    organizationName: "amir",
    defaultNamespaceId: "S7mQcHZCtj",
  };
  const teamOwnedOrg = {
    organizationId: "crwNcCnClI",
    organizationName: "Dale Zwizinski's Org",
    defaultNamespaceId: "VIA2C5VDxj",
  };

  it("uses developer org when follower and owned org disagree (Papr personal workspace)", () => {
    expect(
      resolveNamespaceOrganizationId({
        followerOrgId: "rCalm7lyoq",
        ownedOrg: thinOwnedOrg,
        developerOrgId,
      }),
    ).toBe(developerOrgId);
  });

  it("uses dedicated owned org when follower and owned agree (Myadvice team workspace)", () => {
    expect(
      resolveNamespaceOrganizationId({
        followerOrgId: "crwNcCnClI",
        ownedOrg: teamOwnedOrg,
        developerOrgId,
      }),
    ).toBe("crwNcCnClI");
  });

  it("uses follower org for member workspaces without an owned org", () => {
    expect(
      resolveNamespaceOrganizationId({
        followerOrgId: "T1HzjVDD3R",
        developerOrgId,
      }),
    ).toBe("T1HzjVDD3R");
  });
});
