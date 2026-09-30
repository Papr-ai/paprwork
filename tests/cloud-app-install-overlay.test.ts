import { describe, expect, it } from "vitest";
import {
  cloudAppInstallPhaseForElapsed,
  CLOUD_APP_INSTALL_PHASE_AFTER_MS,
} from "../ui/stores/cloudAppInstallOverlayStore";

describe("cloudAppInstallPhaseForElapsed", () => {
  it("starts at prepare", () => {
    expect(cloudAppInstallPhaseForElapsed(0)).toBe("prepare");
  });

  it("advances through phases by elapsed time", () => {
    expect(cloudAppInstallPhaseForElapsed(CLOUD_APP_INSTALL_PHASE_AFTER_MS.source)).toBe(
      "source",
    );
    expect(cloudAppInstallPhaseForElapsed(CLOUD_APP_INSTALL_PHASE_AFTER_MS.finalize)).toBe(
      "finalize",
    );
  });
});
