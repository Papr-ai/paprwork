import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("../../../src/gateway/services/CloudSyncService.js", () => ({
  getCloudSyncService: () => ({ pushAppNowInBackground: push }),
}));
vi.mock("../../../src/gateway/services/cloudSync/notifyCloudAppRevision.js", () => ({
  resolvePublishRouteForNotify: () => null,
  notifyCloudAppAccessUpdated: vi.fn(),
}));

import { scheduleCloudAppHostAccessInvalidation } from "../../../src/gateway/services/cloudAppPublishAllowlistSync.js";

// The push runs after a dynamic import + file write; a fixed 50ms wait was
// too short on 2-CPU CI. Wait for the expected count, then give a stray
// extra push time to show up.
const settle = () => new Promise((r) => setTimeout(r, 150));
const expectPushes = async (n: number) => {
  await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(n), { timeout: 3000 });
  await settle();
  expect(push).toHaveBeenCalledTimes(n);
};

describe("scheduleCloudAppHostAccessInvalidation", () => {
  let dir = "";
  afterEach(async () => {
    push.mockReset();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("pushes only when the allowlist file actually changes (no publish loop)", async () => {
    dir = await mkdtemp(join(tmpdir(), "papr-allowlist-"));
    await mkdir(join(dir, "apps", "app-1"), { recursive: true });
    const prefs = { allowedUserIds: ["u1"], allowedEmails: [], allowedEmailDomains: [] };
    const config = { shareUrl: null, slug: null } as never;

    scheduleCloudAppHostAccessInvalidation(dir, "app-1", config, prefs);
    await expectPushes(1);

    // Regression: every catalog update (each publish) pushed again → ~20s loop.
    scheduleCloudAppHostAccessInvalidation(dir, "app-1", config, prefs);
    await settle();
    await settle();
    expect(push).toHaveBeenCalledTimes(1);

    scheduleCloudAppHostAccessInvalidation(dir, "app-1", config, { ...prefs, allowedUserIds: ["u2"] });
    await expectPushes(2);
  });
});
