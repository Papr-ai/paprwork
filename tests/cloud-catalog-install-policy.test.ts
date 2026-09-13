import { describe, expect, it } from "vitest";
import {
  getCloudCatalogInstallModeOptions,
  requiresInstallModeChoice,
  resolveAutomaticInstallMode,
} from "../src/core/utils/cloudCatalogInstallPolicy.js";

describe("cloudCatalogInstallPolicy", () => {
  it("auto-forks community apps", () => {
    expect(
      requiresInstallModeChoice({
        catalogScope: "global",
        visibility: "public_read",
        codeInstallable: true,
      }),
    ).toBe(false);
    expect(
      resolveAutomaticInstallMode({
        catalogScope: "global",
        visibility: "public_read",
        codeInstallable: true,
      }),
    ).toBe("fork");
  });

  it("prompts fork vs collaborate for team-shared namespace apps", () => {
    expect(
      requiresInstallModeChoice({
        catalogScope: "namespace",
        visibility: "team",
        codeInstallable: true,
      }),
    ).toBe(true);
    expect(
      resolveAutomaticInstallMode({
        catalogScope: "namespace",
        visibility: "team",
        codeInstallable: true,
      }),
    ).toBeNull();
    expect(
      getCloudCatalogInstallModeOptions({
        catalogScope: "namespace",
        visibility: "team",
        codeInstallable: true,
      }).map((option) => option.mode),
    ).toEqual(["fork", "track"]);
  });

  it("auto-forks non-team-shared namespace apps", () => {
    expect(
      requiresInstallModeChoice({
        catalogScope: "namespace",
        visibility: "public_read",
        codeInstallable: true,
      }),
    ).toBe(false);
  });
});
