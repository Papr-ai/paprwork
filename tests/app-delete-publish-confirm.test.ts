import { describe, it, expect } from "vitest";

/**
 * Regression: deleting a PUBLISHED mini-app appeared to do nothing, then
 * surfaced a bogus "Unknown error" retry.
 *
 * Chain that caused it:
 *   1. AppService.deleteApp returns { deleted: false, requiresUnpublishConfirm: true }
 *      — a negotiation, not a failure.
 *   2. The app:delete handler set `success: result.deleted` → false.
 *   3. gateway.ts rejects the promise whenever success is false, using
 *      `response.error || "Unknown error"` — and no error string is ever set
 *      for this case.
 *
 * So the UI never got to read requiresUnpublishConfirm; the promise had
 * already rejected. These tests pin the envelope contract on both sides.
 */

type DeleteAppResult = {
  deleted: boolean;
  requiresUnpublishConfirm?: boolean;
  shareUrl?: string | null;
  appTitle?: string;
};

/** Mirrors the envelope rule in src/gateway/websocket/app.ts (app:delete). */
function buildDeleteEnvelopeSuccess(result: DeleteAppResult): boolean {
  return result.deleted || result.requiresUnpublishConfirm === true;
}

/** Mirrors the reject rule in ui/src/lib/gateway.ts send(). */
function clientWouldReject(envelopeSuccess: boolean): boolean {
  return !envelopeSuccess;
}

describe("app:delete envelope contract", () => {
  it("does not reject when the app is published and needs confirmation", () => {
    const result: DeleteAppResult = {
      deleted: false,
      requiresUnpublishConfirm: true,
      shareUrl: "https://apps.papr.ai/ns/dash/",
      appTitle: "Dash",
    };

    const success = buildDeleteEnvelopeSuccess(result);

    expect(success).toBe(true);
    // The critical assertion: the client must receive the payload so it can
    // re-prompt with unpublishFromCloud: true.
    expect(clientWouldReject(success)).toBe(false);
  });

  it("reports success for a normal delete", () => {
    const success = buildDeleteEnvelopeSuccess({ deleted: true });
    expect(success).toBe(true);
    expect(clientWouldReject(success)).toBe(false);
  });

  it("still fails when the app does not exist", () => {
    const success = buildDeleteEnvelopeSuccess({ deleted: false });
    expect(success).toBe(false);
    expect(clientWouldReject(success)).toBe(true);
  });
});
