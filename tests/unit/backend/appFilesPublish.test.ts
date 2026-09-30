/**
 * Phase 3 tests: what publishing decides to do with an app's files.
 *
 * The bias here is toward the silent failures. A file that publishes when it
 * should not is a privacy breach; a file that ships broken is a bug the author
 * never sees. Both are covered explicitly.
 */

import { describe, it, expect, vi } from "vitest";
import type { AppFileRow } from "../../../src/gateway/services/appFiles/appFilesSchema.js";
import {
  planPublishAssets,
  describeBlockingAssets,
} from "../../../src/gateway/services/appFiles/publishAssets.js";
import {
  applyPublishVisibility,
  revokePublishVisibility,
} from "../../../src/gateway/services/appFiles/publishAssetSync.js";
import { describeOversizedSkip } from "../../../src/gateway/services/cloudSync/gitSyncLimits.js";

function row(over: Partial<AppFileRow> = {}): AppFileRow {
  return {
    id: "f1",
    app_id: "app1",
    object_key: "ns/app1/abc",
    sha256: "abc",
    size_bytes: 1024,
    mime: "video/mp4",
    file_name: "demo.mp4",
    scope: "app",
    local_path: "/tmp/demo.mp4",
    upload_state: "verified",
    visibility: "inherit",
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe("planPublishAssets", () => {
  it("publishes a verified app-scoped file", () => {
    const plan = planPublishAssets([row()]);
    expect(plan.toPublish).toHaveLength(1);
    expect(plan.blocking).toHaveLength(0);
  });

  it("never publishes a user-scoped file", () => {
    // The meeting-recording guarantee: a public app must not expose a personal
    // file just because it lives in the same database.
    const plan = planPublishAssets([row({ scope: "user" })]);
    expect(plan.toPublish).toHaveLength(0);
    expect(plan.toKeepPrivate).toHaveLength(1);
  });

  it("never publishes a file marked private", () => {
    const plan = planPublishAssets([row({ visibility: "private" })]);
    expect(plan.toPublish).toHaveLength(0);
    expect(plan.toKeepPrivate).toHaveLength(1);
  });

  it("does not block on a private file that is only local", () => {
    // Private files are never served, so their upload state is irrelevant.
    // Blocking here would make publishing fail for no reachable reason.
    const plan = planPublishAssets([
      row({ visibility: "private", upload_state: "pending", local_path: "/x" }),
    ]);
    expect(plan.blocking).toHaveLength(0);
    expect(plan.toKeepPrivate).toHaveLength(1);
  });

  it("blocks a local-only file that the cloud cannot serve", () => {
    // This is the original bug: desktop works, web serves a broken asset.
    const plan = planPublishAssets([
      row({ upload_state: "pending", local_path: "/tmp/demo.mp4" }),
    ]);
    expect(plan.blocking).toHaveLength(1);
    expect(plan.toPublish).toHaveLength(0);
  });

  it("blocks a failed upload", () => {
    const plan = planPublishAssets([row({ upload_state: "failed" })]);
    expect(plan.blocking[0].reason).toContain("upload failed");
  });

  it("names the file in the blocking message", () => {
    // "Publish failed" is not actionable. The filename is.
    const plan = planPublishAssets([
      row({ upload_state: "pending", file_name: "keynote.mp4" }),
    ]);
    const message = describeBlockingAssets(plan.blocking);
    expect(message).toContain("keynote.mp4");
    expect(message).toContain("App Files");
  });
});

describe("applyPublishVisibility", () => {
  it("flips only the publishable objects", async () => {
    const setVisibility = vi.fn().mockResolvedValue({});
    const { result } = await applyPublishVisibility(
      "app1",
      [
        row({ id: "a", object_key: "k/a" }),
        row({ id: "b", object_key: "k/b", scope: "user" }),
      ],
      setVisibility,
    );
    expect(result.flipped).toEqual(["k/a"]);
    expect(setVisibility).toHaveBeenCalledTimes(1);
    expect(setVisibility).toHaveBeenCalledWith("app1", "k/a", true);
  });

  it("throws before flipping anything when an asset would ship broken", async () => {
    // A partial flip followed by a failed publish would leave objects public
    // for an app that never went live.
    const setVisibility = vi.fn().mockResolvedValue({});
    await expect(
      applyPublishVisibility(
        "app1",
        [row({ id: "a" }), row({ id: "b", upload_state: "pending" })],
        setVisibility,
      ),
    ).rejects.toThrow(/Cannot publish/);
    expect(setVisibility).not.toHaveBeenCalled();
  });

  it("throws when an object fails to become public", async () => {
    // Reporting a clean publish while one asset 404s for every visitor is the
    // exact silent failure this phase exists to remove.
    const setVisibility = vi.fn().mockRejectedValue(new Error("403 denied"));
    await expect(
      applyPublishVisibility("app1", [row()], setVisibility),
    ).rejects.toThrow(/could not be made public/);
  });
});

describe("revokePublishVisibility", () => {
  it("makes published objects private again", async () => {
    const setVisibility = vi.fn().mockResolvedValue({});
    const result = await revokePublishVisibility(
      "app1",
      [row({ object_key: "k/a" })],
      setVisibility,
    );
    expect(setVisibility).toHaveBeenCalledWith("app1", "k/a", false);
    expect(result.flipped).toEqual(["k/a"]);
  });

  it("reports failures instead of throwing", async () => {
    // Unpublish must always be able to complete.
    const setVisibility = vi.fn().mockRejectedValue(new Error("network"));
    const result = await revokePublishVisibility("app1", [row()], setVisibility);
    expect(result.failed).toHaveLength(1);
    expect(result.flipped).toHaveLength(0);
  });

  it("skips objects that were never public", async () => {
    const setVisibility = vi.fn().mockResolvedValue({});
    await revokePublishVisibility(
      "app1",
      [row({ scope: "user" }), row({ upload_state: "pending" })],
      setVisibility,
    );
    expect(setVisibility).not.toHaveBeenCalled();
  });
});

describe("describeOversizedSkip", () => {
  it("points at App Files instead of just reporting a skip", () => {
    const message = describeOversizedSkip(["apps/a1/assets/demo.mp4"]);
    expect(message).toContain("demo.mp4");
    expect(message).toContain("App Files");
  });

  it("truncates long lists but keeps the count honest", () => {
    const paths = Array.from({ length: 9 }, (_, i) => `apps/a1/f${i}.mp4`);
    const message = describeOversizedSkip(paths);
    expect(message).toContain("9 files are");
    expect(message).toContain("and 4 more");
  });
});
