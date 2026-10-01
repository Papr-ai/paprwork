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

  it("track + per-user starts on own data by default, refuses explicit shared", () => {
    expect(resolveInstallDbPolicy("track", ["per-user"], "namespace")).toBe("fork_empty");
    expect(() =>
      resolveInstallDbPolicy("track", ["per-user"], "namespace", "shared_primary"),
    ).toThrow(CloudInstallDbPolicyError);
    expect(resolveInstallDbPolicy("track", ["per-user"], "global", "fork_empty")).toBe("fork_empty");
  });

  it("v5: team app reached as link/public (not team) starts on own data instead of failing", () => {
    expect(resolveInstallDbPolicy("track", ["shared"], "namespace", undefined, "link_read")).toBe("fork_empty");
    expect(resolveInstallDbPolicy("track", ["shared"], "namespace", undefined, "public_read")).toBe("fork_empty");
    expect(resolveInstallDbPolicy("track", ["shared"], "namespace", undefined, "team")).toBe("shared_primary");
    expect(resolveInstallDbPolicy("track", ["shared"], "namespace", undefined, "owner")).toBe("shared_primary");
    // Older servers don't send accessMode; the DB token endpoint still enforces.
    expect(resolveInstallDbPolicy("track", ["shared"], "namespace", undefined, undefined)).toBe("shared_primary");
  });

  it("v5: server access gate only refuses an explicit request for team data", () => {
    expect(() =>
      assertTrackAccessFromServer({ mode: "track", catalogScope: "namespace", accessMode: "link_read" }),
    ).not.toThrow();
    expect(() =>
      assertTrackAccessFromServer({ mode: "track", catalogScope: "namespace", accessMode: "link_read", explicitPolicy: "shared_primary" }),
    ).toThrow(CloudInstallDbPolicyError);
    expect(() =>
      assertTrackAccessFromServer({ mode: "track", catalogScope: "namespace", accessMode: "team", explicitPolicy: "shared_primary" }),
    ).not.toThrow();
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

  it("rejects an explicit team-data install when the server reports non-team access", () => {
    expect(() =>
      assertTrackAccessFromServer({
        mode: "track",
        catalogScope: "namespace",
        accessMode: "public_read",
        explicitPolicy: "shared_primary",
      }),
    ).toThrow(/you reach this app as "public_read"/);
  });

  it("allows collaborate for team/owner access and older servers", () => {
    for (const accessMode of ["team", "owner", "people", undefined]) {
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
