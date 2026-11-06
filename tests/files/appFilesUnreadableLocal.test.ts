/**
 * A local copy that exists but cannot be read must not shadow the cloud copy.
 *
 * macOS privacy (TCC) lets a process stat() a file in ~/Documents while open()
 * fails with EPERM — e.g. after an in-place update leaves the running app's
 * signature stale. resolveFileUrl used to check existence only, so it pointed
 * the app at the unreadable local file and every image broke even though a
 * verified cloud copy was right there.
 */

import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const createReadUrl = vi.fn(async () => ({ url: "https://signed.example/who.gif" }));

vi.mock("../../src/gateway/services/appFiles/appFilesClient.js", () => ({
  requestUploadTicket: vi.fn(),
  commitUpload: vi.fn(),
  createReadUrl: (...args: unknown[]) => createReadUrl(...(args as [])),
  deleteObject: vi.fn(),
}));

const { resolveFileUrl, canReadLocal } = await import(
  "../../src/gateway/services/appFiles/AppFilesService.js"
);

function dbWith(row: Record<string, unknown>) {
  return {
    async exec() {},
    async run() { return { changes: 0 }; },
    async all() { return [row]; },
  } as never;
}

const base = { id: "f1", app_id: "app", object_key: "apps/app/who.gif", file_name: "who.gif", upload_state: "verified" };

describe("resolveFileUrl with an unreadable local copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "appfiles-"));
  const readable = join(dir, "ok.gif");
  const blocked = join(dir, "blocked.gif");
  writeFileSync(readable, "GIF89a");
  writeFileSync(blocked, "GIF89a");
  chmodSync(blocked, 0o000); // stands in for TCC: exists, but open() fails

  it("detects a file that exists but cannot be opened", () => {
    expect(canReadLocal(readable)).toBe(true);
    if (process.getuid?.() !== 0) expect(canReadLocal(blocked)).toBe(false);
    expect(canReadLocal(join(dir, "missing.gif"))).toBe(false);
  });

  it("serves the verified cloud copy instead", async () => {
    if (process.getuid?.() === 0) return; // root ignores file modes
    const r = await resolveFileUrl(dbWith({ ...base, local_path: blocked }), "f1");
    expect(r.location.kind).toBe("cloud");
    expect(r.url).toBe("https://signed.example/who.gif");
  });

  it("still prefers a readable local copy", async () => {
    const r = await resolveFileUrl(dbWith({ ...base, local_path: readable }), "f1");
    expect(r.location).toEqual({ kind: "local", path: readable });
  });
});
