import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isOwnerPreviewDatabase, withOwnerPublishApply } from "./ownerPreviewData.js";

function home(live: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), "owner-pv-"));
  mkdirSync(path.join(root, "apps", "a1"), { recursive: true });
  writeFileSync(path.join(root, "apps", "a1", "data-sources.json"), JSON.stringify({ sources: [{ dbId: "db-1" }] }));
  if (live) {
    mkdirSync(path.join(root, "data", "live-code", "a1"), { recursive: true });
    writeFileSync(path.join(root, "data", "live-code", "a1", "index.html"), "<html>");
  }
  return root;
}
const deps = (paprRoot: string, o: Partial<{ collab: boolean; iso: string; cloud: boolean }> = {}) => ({
  isCollaboratorOnShared: () => o.collab ?? false,
  record: () => ({ isolation: o.iso ?? "shared" }),
  isCloudRun: () => o.cloud ?? false,
  paprRoot,
});

describe("isOwnerPreviewDatabase", () => {
  afterEach(() => delete process.env.PAPR_OWNER_PREVIEW_DATA);
  it("off unless PAPR_OWNER_PREVIEW_DATA=1", async () => {
    expect(await isOwnerPreviewDatabase("db-1", deps(home(true)))).toBe(false);
  });
  it("owner of a live app: schema changes wait in Preview", async () => {
    process.env.PAPR_OWNER_PREVIEW_DATA = "1";
    expect(await isOwnerPreviewDatabase("db-1", deps(home(true)))).toBe(true);
  });
  it("not live yet, teammate, per-user, cloud run: apply right away", async () => {
    process.env.PAPR_OWNER_PREVIEW_DATA = "1";
    expect(await isOwnerPreviewDatabase("db-1", deps(home(false)))).toBe(false);
    expect(await isOwnerPreviewDatabase("db-1", deps(home(true), { collab: true }))).toBe(false);
    expect(await isOwnerPreviewDatabase("db-1", deps(home(true), { iso: "per-user" }))).toBe(false);
    expect(await isOwnerPreviewDatabase("db-1", deps(home(true), { cloud: true }))).toBe(false);
  });
  it("publish applies for real", async () => {
    process.env.PAPR_OWNER_PREVIEW_DATA = "1";
    const root = home(true);
    expect(await withOwnerPublishApply("db-1", () => isOwnerPreviewDatabase("db-1", deps(root)))).toBe(false);
    expect(await isOwnerPreviewDatabase("db-1", deps(root))).toBe(true);
  });
});
