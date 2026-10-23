import { describe, expect, it } from "vitest";
import { decideTrackPullAction, PAUSED_RECHECK_MS } from "./trackPullOnPublishLogic.js";
import { installDeniedReason } from "../CloudAppInstallService.js";
import { updatesPausedMessage } from "../../../core/utils/updatesPausedMessage.js";

const hdr = (v?: string) => ({ get: (n: string) => (n.toLowerCase() === "x-papr-denied-reason" ? v ?? null : null) });

describe("updates paused when the publisher refuses", () => {
  const at = "2026-10-19T00:00:00.000Z";
  const now = Date.parse(at);

  it("skips paused copies until the daily re-check", () => {
    const lineage = { trackAutoPull: true, upstreamRevision: undefined, updatesPaused: { reason: "code_access_off" as const, at } };
    expect(decideTrackPullAction({ mode: "track", lineage, liveRevision: "abc", now: now + 60_000 })).toEqual({
      action: "skip",
      reason: "updates_paused",
    });
    expect(decideTrackPullAction({ mode: "track", lineage, liveRevision: "abc", now: now + PAUSED_RECHECK_MS })).toEqual({
      action: "pull",
    });
  });

  it("auto-pull off is decided before any network call (no live revision needed)", () => {
    expect(decideTrackPullAction({ mode: "track", lineage: { trackAutoPull: false }, liveRevision: "?" }).action).toBe("skip");
  });

  it("reads the reason from the header, falls back to the message, ignores 401", () => {
    expect(installDeniedReason({ status: 403, headers: hdr("code_access_off") }, "")).toBe("code_access_off");
    expect(installDeniedReason({ status: 403, headers: hdr() }, '{"detail":"Code install is not enabled for this app"}')).toBe("code_access_off");
    expect(installDeniedReason({ status: 403, headers: hdr() }, '{"detail":"No read access to this app"}')).toBe("no_access");
    expect(installDeniedReason({ status: 403, headers: hdr() }, "nope")).toBe("denied");
    expect(installDeniedReason({ status: 401, headers: hdr("no_access") }, "")).toBeUndefined();
    expect(installDeniedReason({ status: 500, headers: hdr() }, "")).toBeUndefined();
  });

  it("tells the user what changed and who can fix it", () => {
    expect(updatesPausedMessage("code_access_off")).toMatch(/turned off code sharing.*Ask them/);
    expect(updatesPausedMessage("no_access", "The publisher of scout")).toMatch(/^The publisher of scout changed who can access/);
  });
});
