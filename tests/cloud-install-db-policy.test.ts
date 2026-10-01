import { describe, expect, it } from "vitest";
import {
  assertTrackAccessFromServer,
  assertTrackAllowedForCatalog,
  CloudInstallDbPolicyError,
  databasePolicyFromInstallPolicy,
  resolveInstallDbPolicy,
} from "../src/gateway/services/cloudInstallDbPolicy.js";

describe("cloudInstallDbPolicy", () => {
  it("fork mode always resolves to fork_empty", () => {
    expect(resolveInstallDbPolicy("fork", [])).toBe("fork_empty");
    expect(resolveInstallDbPolicy("fork", ["shared", "per-user"])).toBe(
      "fork_empty",
    );
  });

  it("track + shared resolves to shared_primary by default on team apps", () => {
    expect(resolveInstallDbPolicy("track", ["shared"], "namespace")).toBe(
      "shared_primary",
    );
    expect(resolveInstallDbPolicy("track", [], "namespace")).toBe(
      "shared_primary",
    );
  });

  it("honours explicit team track + fork_empty", () => {
    expect(
      resolveInstallDbPolicy("track", ["shared"], "namespace", "fork_empty"),
    ).toBe("fork_empty");
  });

  it("rejects shared_primary on community track", () => {
    expect(() =>
      resolveInstallDbPolicy("track", [], "global", "shared_primary"),
    ).toThrow(CloudInstallDbPolicyError);
  });

  it("track + per-user throws", () => {
    expect(() => resolveInstallDbPolicy("track", ["per-user"])).toThrow(
      CloudInstallDbPolicyError,
    );
  });

  it("maps install policy to lineage databasePolicy", () => {
    expect(databasePolicyFromInstallPolicy("fork_empty")).toBe("forked");
    expect(databasePolicyFromInstallPolicy("shared_primary")).toBe("shared");
  });

  it("allows track on global community catalog (code lineage, private data)", () => {
    expect(() =>
      assertTrackAllowedForCatalog({
        mode: "track",
        catalogScope: "global",
      }),
    ).not.toThrow();
  });

  it("never attaches the publisher database for community collaborate", () => {
    expect(resolveInstallDbPolicy("track", ["shared"], "global")).toBe(
      "fork_empty",
    );
  });

  it("rejects track when visibility is not team", () => {
    expect(() =>
      assertTrackAllowedForCatalog({
        mode: "track",
        catalogScope: "namespace",
        visibility: "public_read",
      }),
    ).toThrow(/requires a team-shared app/);
  });

  it("allows track for team namespace apps", () => {
    expect(() =>
      assertTrackAllowedForCatalog({
        mode: "track",
        catalogScope: "namespace",
        visibility: "team",
      }),
    ).not.toThrow();
  });

  it("defers to the server when visibility is not passed", () => {
    expect(() =>
      assertTrackAllowedForCatalog({
        mode: "track",
        catalogScope: "namespace",
      }),
    ).not.toThrow();
  });

  it("rejects team collaborate when the server reports non-team access", () => {
    expect(() =>
      assertTrackAccessFromServer({
        mode: "track",
        catalogScope: "namespace",
        accessMode: "public_read",
      }),
    ).toThrow(/you reach this app as "public_read"/);
  });

  it("allows collaborate for team/owner access and older servers", () => {
    for (const accessMode of ["team", "owner", undefined]) {
      expect(() =>
        assertTrackAccessFromServer({ mode: "track", catalogScope: "namespace", accessMode }),
      ).not.toThrow();
    }
    expect(() =>
      assertTrackAccessFromServer({ mode: "fork", catalogScope: "namespace", accessMode: "public_read" }),
    ).not.toThrow();
  });

  it("names the actual visibility when it is not team", () => {
    expect(() =>
      assertTrackAllowedForCatalog({
        mode: "track",
        catalogScope: "namespace",
        visibility: "public_read",
      }),
    ).toThrow(/visibility is "public_read"/);
  });
});
