import { describe, expect, it } from "vitest";
import { checkStaleBundle } from "../src/gateway/utils/miniAppStartupHealth.js";

/**
 * validateApp rebuilds dist immediately before this check. When that build
 * passed, a newer source mtime is a sibling write racing the check (parallel
 * agent edits), not stale code. runValidation passes `null` for the source
 * mtime in that case; this pins the contract on both sides.
 */
describe("stale-bundle check after a passing rebuild", () => {
  const html = `<script type="module" src="dist/app.js"></script>`;

  it("source newer than dist is an error only when caller reports it", () => {
    expect(checkStaleBundle(html, 1000, 2000)).toHaveLength(1);
    expect(checkStaleBundle(html, 1000, null)).toHaveLength(0);
  });

  it("missing dist stays an error regardless (app cannot boot)", () => {
    expect(checkStaleBundle(html, null, null)[0]?.severity).toBe("error");
  });
});
