import { describe, expect, it } from "vitest";
import {
  cloudCatalogInstallOptionKey,
  getCloudCatalogInstallModeOptions,
  requiresInstallModeChoice,
  resolveAutomaticInstallMode,
} from "../src/core/utils/cloudCatalogInstallPolicy.js";

describe("cloudCatalogInstallPolicy", () => {
  it("asks copy vs collaborate for forkable community apps", () => {
    expect(
      requiresInstallModeChoice({
        catalogScope: "global",
        visibility: "public_read",
        codeInstallable: true,
      }),
    ).toBe(true);
    // No silent default any more: the installer must state intent.
    expect(
      resolveAutomaticInstallMode({
        catalogScope: "global",
        visibility: "public_read",
        codeInstallable: true,
      }),
    ).toBeNull();
    expect(
      getCloudCatalogInstallModeOptions({
        catalogScope: "global",
        visibility: "public_read",
        codeInstallable: true,
      }).map((option) => cloudCatalogInstallOptionKey(option)),
    ).toEqual(["fork:fork_empty", "track:fork_empty"]);
    expect(
      getCloudCatalogInstallModeOptions({
        catalogScope: "global",
        visibility: "public_read",
        codeInstallable: true,
      }).map((option) => option.label),
    ).toEqual(["Install a copy", "Collaborate (no data sharing)"]);
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
      }).map((option) => cloudCatalogInstallOptionKey(option)),
    ).toEqual([
      "fork:fork_empty",
      "track:fork_empty",
      "track:shared_primary",
    ]);
    expect(
      getCloudCatalogInstallModeOptions({
        catalogScope: "namespace",
        visibility: "team",
        codeInstallable: true,
      }).map((option) => option.label),
    ).toEqual([
      "Install a copy",
      "Collaborate (no data sharing)",
      "Collaborate (data sharing)",
    ]);
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
