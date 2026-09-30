import { describe, expect, it } from "vitest";

import {
  applyPeopleAllowlist,
  isPeopleRestricted,
} from "./cloudAppPeopleAccess.js";
import type { AppAccessContext } from "./types.js";
import {
  audienceModelToSharing,
  audienceRequiresSignIn,
  isUserAllowedByAudienceModel,
  normalizeAllowedUserIds,
  sharingToAudienceModel,
} from "../../../core/utils/shareAudienceModel.js";

const PUBLISHER = "pub-shawkat";
const ALLOWED = "usr-amir";
const OUTSIDER = "usr-colleague";

function teamAccess(
  overrides: Partial<AppAccessContext> = {},
): AppAccessContext {
  return {
    orgId: "org-1",
    namespaceId: "ns-1",
    userId: PUBLISHER,
    appId: "app-1",
    mode: "team",
    canRead: true,
    canWrite: true,
    ...overrides,
  };
}

describe("applyPeopleAllowlist", () => {
  it("passes through when there is no allowlist", () => {
    // Absence of a list is "anyone in my workspace", not "nobody". Every
    // already-published team app hits this path.
    const decision = applyPeopleAllowlist(teamAccess(), undefined, OUTSIDER);
    expect(decision.denied).toBe(false);
    expect(decision.access.canRead).toBe(true);
    expect(decision.access.canWrite).toBe(true);
  });

  it("treats an empty allowlist as not restricted", () => {
    const decision = applyPeopleAllowlist(teamAccess(), [], OUTSIDER);
    expect(decision.denied).toBe(false);
    expect(decision.access.canRead).toBe(true);
  });

  it("allows a caller on the allowlist", () => {
    const decision = applyPeopleAllowlist(teamAccess(), [ALLOWED], ALLOWED);
    expect(decision.denied).toBe(false);
    expect(decision.access.canRead).toBe(true);
    expect(decision.access.canWrite).toBe(true);
  });

  it("denies a workspace member who is not on the allowlist", () => {
    // The whole point: the cloud ACL is "team", so this caller is already
    // authenticated and authorised by the memory server.
    const decision = applyPeopleAllowlist(teamAccess(), [ALLOWED], OUTSIDER);
    expect(decision.denied).toBe(true);
    expect(decision.reason).toBe("not_in_allowlist");
    expect(decision.access.canRead).toBe(false);
    expect(decision.access.canWrite).toBe(false);
  });

  it("revokes read as well as write, not just the action attempted", () => {
    const decision = applyPeopleAllowlist(
      teamAccess({ canWrite: false }),
      [ALLOWED],
      OUTSIDER,
    );
    expect(decision.access.canRead).toBe(false);
    expect(decision.access.canWrite).toBe(false);
  });

  it("denies an anonymous caller when an allowlist exists", () => {
    const decision = applyPeopleAllowlist(teamAccess(), [ALLOWED], undefined);
    expect(decision.denied).toBe(true);
    expect(decision.reason).toBe("sign_in_required");
    expect(decision.access.canRead).toBe(false);
  });

  it("never locks out the owner session", () => {
    const decision = applyPeopleAllowlist(
      teamAccess({ mode: "owner" }),
      [ALLOWED],
      OUTSIDER,
    );
    expect(decision.denied).toBe(false);
    expect(decision.access.canRead).toBe(true);
  });

  it("never locks out the publisher, even if they omit themselves", () => {
    const decision = applyPeopleAllowlist(teamAccess(), [ALLOWED], PUBLISHER);
    expect(decision.denied).toBe(false);
    expect(decision.access.canRead).toBe(true);
  });

  it("ignores surrounding whitespace on the caller id", () => {
    const decision = applyPeopleAllowlist(
      teamAccess(),
      [` ${ALLOWED} `],
      ALLOWED,
    );
    expect(decision.denied).toBe(false);
  });

  it("does not mutate the access context it was given", () => {
    const access = teamAccess();
    applyPeopleAllowlist(access, [ALLOWED], OUTSIDER);
    expect(access.canRead).toBe(true);
    expect(access.canWrite).toBe(true);
  });
});

describe("isPeopleRestricted", () => {
  it("is false for absent, empty, and blank-only lists", () => {
    expect(isPeopleRestricted(undefined)).toBe(false);
    expect(isPeopleRestricted([])).toBe(false);
    expect(isPeopleRestricted(["", "  "])).toBe(false);
  });

  it("is true once a real user is listed", () => {
    expect(isPeopleRestricted([ALLOWED])).toBe(true);
  });
});

describe("normalizeAllowedUserIds", () => {
  it("trims, drops blanks, and de-duplicates while keeping pick order", () => {
    expect(
      normalizeAllowedUserIds([" b ", "a", "b", "", "   ", "a"]),
    ).toEqual(["b", "a"]);
  });
});

describe("share audience model — people", () => {
  it("publishes with the team ACL and no external link", () => {
    expect(
      audienceModelToSharing({
        audience: "people",
        permission: "write",
        allowedUserIds: [ALLOWED],
      }),
    ).toEqual({ loginAccess: "team", externalLink: "off" });
  });

  it("requires Papr sign-in", () => {
    expect(
      audienceRequiresSignIn({ audience: "people", permission: "write" }),
    ).toBe(true);
  });

  it("round-trips team + allowlist back to the people audience", () => {
    const model = sharingToAudienceModel("team", "off", "off", {
      allowedUserIds: [ALLOWED],
    });
    expect(model.audience).toBe("people");
    expect(model.allowedUserIds).toEqual([ALLOWED]);
  });

  it("stays plain team when no allowlist is stored", () => {
    // Guards the upgrade path: existing team apps must not silently become
    // restricted, which would lock out everyone.
    expect(sharingToAudienceModel("team", "off", "off").audience).toBe("team");
    expect(
      sharingToAudienceModel("team", "off", "off", { allowedUserIds: [] })
        .audience,
    ).toBe("team");
  });

  it("keeps the allowlist when code access is also shared", () => {
    const model = sharingToAudienceModel("team", "off", "install", {
      allowedUserIds: [ALLOWED],
    });
    expect(model.audience).toBe("people");
    expect(model.permission).toBe("edit");
    expect(model.allowedUserIds).toEqual([ALLOWED]);
  });

  it("does not constrain non-people audiences", () => {
    expect(
      isUserAllowedByAudienceModel(
        { audience: "team", allowedUserIds: [ALLOWED] },
        OUTSIDER,
        PUBLISHER,
      ),
    ).toBe(true);
  });

  it("publishes external guests with public login access", () => {
    expect(
      audienceModelToSharing({
        audience: "people",
        permission: "write",
        allowedEmailDomains: ["acme.com"],
      }),
    ).toEqual({ loginAccess: "public", externalLink: "off" });
  });
});

describe("applyPeopleAllowlist — external email", () => {
  it("allows a signed-in guest on the email list", () => {
    const decision = applyPeopleAllowlist(
      teamAccess(),
      { allowedEmails: ["guest@acme.com"] },
      undefined,
      "guest@acme.com",
    );
    expect(decision.denied).toBe(false);
  });

  it("allows a signed-in guest on the domain list", () => {
    const decision = applyPeopleAllowlist(
      teamAccess(),
      { allowedEmailDomains: ["acme.com"] },
      undefined,
      "anyone@acme.com",
    );
    expect(decision.denied).toBe(false);
  });

  it("denies a guest with the wrong email", () => {
    const decision = applyPeopleAllowlist(
      teamAccess(),
      { allowedEmails: ["guest@acme.com"] },
      undefined,
      "other@evil.com",
    );
    expect(decision.denied).toBe(true);
    expect(decision.reason).toBe("not_in_allowlist");
  });

  it("is restricted when only domains are listed", () => {
    expect(isPeopleRestricted({ allowedEmailDomains: ["acme.com"] })).toBe(
      true,
    );
  });
});
