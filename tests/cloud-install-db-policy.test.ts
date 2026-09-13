import { describe, expect, it } from "vitest";
import {
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

  it("track + shared resolves to shared_primary", () => {
    expect(resolveInstallDbPolicy("track", ["shared"])).toBe("shared_primary");
    expect(resolveInstallDbPolicy("track", [])).toBe("shared_primary");
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

  it("rejects track on global community catalog", () => {
    expect(() =>
      assertTrackAllowedForCatalog({
        mode: "track",
        catalogScope: "global",
      }),
    ).toThrow(/Community apps can only be installed as an independent copy/);
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

  it("rejects track without team visibility", () => {
    expect(() =>
      assertTrackAllowedForCatalog({
        mode: "track",
        catalogScope: "namespace",
      }),
    ).toThrow(/requires a team-shared app/);
  });
});
