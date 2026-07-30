import { describe, expect, it } from "vitest";
import {
  resolveLoginOrganizationId,
  resolveNamespaceOrganizationId,
} from "../src/electron/ipc/paprLogin.js";

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

  it("uses dedicated owned org when follower and owned agree (team workspace)", () => {
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

describe("resolveLoginOrganizationId", () => {
  it("prefers resolved namespace org over developer org", () => {
    expect(
      resolveLoginOrganizationId({
        namespaceOrganizationId: "crwNcCnClI",
        provisionOrganizationId: "Y8D4H7Yp3Z",
        developerOrganizationId: "Y8D4H7Yp3Z",
      }),
    ).toBe("crwNcCnClI");
  });

  it("falls back to provision org when namespace org is missing", () => {
    expect(
      resolveLoginOrganizationId({
        provisionOrganizationId: "De6SRb7yNd",
        developerOrganizationId: "Y8D4H7Yp3Z",
      }),
    ).toBe("De6SRb7yNd");
  });

  it("falls back to developer org as last resort", () => {
    expect(
      resolveLoginOrganizationId({
        developerOrganizationId: "Y8D4H7Yp3Z",
      }),
    ).toBe("Y8D4H7Yp3Z");
  });
});
