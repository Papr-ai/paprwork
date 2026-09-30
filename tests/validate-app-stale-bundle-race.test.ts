import { describe, expect, it, vi } from "vitest";

let builds = 0;
const gate: Array<() => void> = [];
vi.mock("../src/gateway/utils/miniAppBuild.js", async (orig) => ({
  ...(await orig<typeof import("../src/gateway/utils/miniAppBuild.js")>()),
  buildMiniApp: () =>
    new Promise((res) => {
      builds++;
      gate.push(() => res({ success: true, errors: [], outputFiles: [], legacy: false }));
    }),
}));
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

describe("buildApp coalescing under parallel writes", () => {
  it("second caller waits, then one fresh build runs; first caller gets the fresh result", async () => {
    const { AppService } = await import("../src/gateway/services/AppService.js");
    const svc = Object.create(AppService.prototype) as any;
    svc.buildInFlight = new Map();
    svc.buildRerunRequested = new Set();
    svc.lastBuildResult = new Map();
    svc.apps = new Map([["a", {}]]);
    Object.defineProperty(svc, "appsDir", { value: "/tmp" });
    const tick = () => new Promise((r) => setTimeout(r, 5));

    const p1 = svc.buildApp("a");
    await tick();
    const p2 = svc.buildApp("a"); // sibling write lands mid-build
    await tick();
    expect(builds).toBe(1);
    gate[0]!(); // first build finishes → superseded → one rerun
    await tick();
    expect(builds).toBe(2);
    gate[1]!();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.success && r2.success).toBe(true);
    expect(builds).toBe(2); // exactly one rerun, not one per waiter
    expect(svc.buildInFlight.size).toBe(0);
  });
});
