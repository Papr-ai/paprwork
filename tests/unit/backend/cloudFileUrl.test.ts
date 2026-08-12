/**
 * Tests for the cloud file-URL decision.
 *
 * This is the authorization surface for serving App Files on apps.papr.ai, so
 * the denial cases matter more than the happy path. Each test names the leak it
 * prevents rather than the branch it covers.
 */

import { describe, expect, it } from "vitest";
import {
  buildCdnUrl,
  resolveCloudFileUrl,
} from "../../../src/gateway/services/appFiles/cloudFileUrl.js";
import type { AppFileRow } from "../../../src/gateway/services/appFiles/appFilesSchema.js";

const NS = "ns-1";
const APP = "app-1";
const SHA = "a".repeat(64);

function appRow(over: Partial<AppFileRow> = {}): AppFileRow {
  return {
    id: "file-1",
    app_id: APP,
    object_key: `namespaces/${NS}/apps/${APP}/files/${SHA}`,
    sha256: SHA,
    size_bytes: 1024,
    mime: "video/mp4",
    file_name: "demo.mp4",
    scope: "app",
    local_path: null,
    upload_state: "verified",
    visibility: "app",
    created_at: 1,
    updated_at: 1,
    ...over,
  } as AppFileRow;
}

function userRow(userId: string, over: Partial<AppFileRow> = {}): AppFileRow {
  return appRow({
    scope: "user",
    object_key: `namespaces/${NS}/apps/${APP}/users/${userId}/files/${SHA}`,
    ...over,
  });
}

const visitor = {
  requestedAppId: APP,
  canRead: true,
  userId: null,
  isPublished: true,
};

describe("resolveCloudFileUrl", () => {
  it("serves a published app file over CDN to a logged-out visitor", () => {
    // The Phase 3 exit criterion: a 60 MB video must load for someone with no
    // account, without a signing round-trip.
    const d = resolveCloudFileUrl(appRow(), visitor);
    expect(d.kind).toBe("cdn");
  });

  it("keeps a private file private even when the app is public", () => {
    // The meeting-recording guarantee. A logged-out visitor gets nothing.
    const d = resolveCloudFileUrl(appRow({ visibility: "private" }), {
      ...visitor,
      canRead: false,
    });
    expect(d).toMatchObject({ kind: "deny", status: 403 });
  });

  it("signs, never CDN-serves, a private file for an entitled reader", () => {
    // Entitled readers still get access — but through a short-lived URL, so it
    // cannot be forwarded or indexed.
    const d = resolveCloudFileUrl(appRow({ visibility: "private" }), visitor);
    expect(d.kind).toBe("signed");
  });

  it("hides another app's file behind 404, not 403", () => {
    // 403 would confirm the id exists. Cross-app probes must not be able to
    // distinguish a real file from a fabricated one.
    const d = resolveCloudFileUrl(appRow({ app_id: "other-app" }), visitor);
    expect(d).toMatchObject({ kind: "deny", status: 404 });
  });

  it("returns 404 for a missing row", () => {
    const d = resolveCloudFileUrl(null, visitor);
    expect(d).toMatchObject({ kind: "deny", status: 404 });
  });

  it("refuses a file that only exists on someone's laptop", () => {
    // Resolves fine on desktop; the cloud has no filesystem to read it from.
    for (const state of ["pending", "uploading", "failed"] as const) {
      const d = resolveCloudFileUrl(appRow({ upload_state: state }), visitor);
      expect(d, state).toMatchObject({ kind: "deny", status: 404 });
    }
  });

  it("never exposes a user-scoped file to a logged-out visitor", () => {
    const d = resolveCloudFileUrl(userRow("user-a"), visitor);
    expect(d).toMatchObject({ kind: "deny", status: 403 });
  });

  it("never exposes a user-scoped file to a different logged-in user", () => {
    const d = resolveCloudFileUrl(userRow("user-a"), {
      ...visitor,
      userId: "user-b",
    });
    expect(d).toMatchObject({ kind: "deny", status: 403 });
  });

  it("gives the owner of a user-scoped file a signed URL", () => {
    const d = resolveCloudFileUrl(userRow("user-a"), {
      ...visitor,
      userId: "user-a",
    });
    expect(d).toMatchObject({ kind: "signed", objectKey: expect.any(String) });
  });

  it("trusts the key over the scope column when they disagree", () => {
    // The column syncs through Turso and a desktop write path; the key is
    // written server-side from the session. A row mislabelled 'app' must not
    // become world-readable on a published app.
    const mislabelled = userRow("user-a", { scope: "app" });
    const d = resolveCloudFileUrl(mislabelled, visitor);
    expect(d).toMatchObject({ kind: "deny", status: 403 });
  });

  it("signs rather than CDN-serves before the app is published", () => {
    // Preview and unpublished apps have no CDN-public objects, so a CDN URL
    // would 403 at the edge and look like data loss to the author.
    const d = resolveCloudFileUrl(appRow(), {
      ...visitor,
      isPublished: false,
    });
    expect(d.kind).toBe("signed");
  });

  it("denies an unpublished app to a caller who cannot read it", () => {
    const d = resolveCloudFileUrl(appRow(), {
      ...visitor,
      isPublished: false,
      canRead: false,
    });
    expect(d).toMatchObject({ kind: "deny", status: 403 });
  });
});

describe("buildCdnUrl", () => {
  it("mirrors the server's cdn_url shape", () => {
    expect(buildCdnUrl("namespaces/n/apps/a/files/abc", "files.papr.ai")).toBe(
      "https://files.papr.ai/namespaces/n/apps/a/files/abc",
    );
  });
});
