import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root = "";
vi.mock("../src/core/utils/paprRoot.js", () => ({
  getPaprDataDir: () => path.join(root, "data"),
  getPaprAppsRoot: () => path.join(root, "apps"),
}));

const covers = await import("../src/gateway/services/appCovers.js");

const big = (n = 6000) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, 7)]).toString("base64")}`;
const APP = "e6d202f3-ea1f-4717-b6da-b39481bcf227";

describe("app covers", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-covers-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("stores validate screenshots privately (outside the app folder)", () => {
    expect(covers.savePrivateCover(APP, big(), "validate").saved).toBe(true);
    expect(fs.existsSync(path.join(root, "data", "covers", `${APP}.img`))).toBe(true);
    expect(fs.existsSync(path.join(root, "apps", APP))).toBe(false);
    expect(covers.resolveCover(APP)?.slot).toBe("private");
  });

  it("throttles tab captures to once a day but always takes validate captures", () => {
    expect(covers.savePrivateCover(APP, big(), "tab").saved).toBe(true);
    expect(covers.savePrivateCover(APP, big(), "tab")).toEqual({ saved: false, reason: "fresh" });
    expect(covers.savePrivateCover(APP, big(), "validate").saved).toBe(true);
  });

  it("keeps the previous cover instead of a blank/loading screenshot", () => {
    covers.savePrivateCover(APP, big(), "validate");
    expect(covers.savePrivateCover(APP, big(100), "validate")).toEqual({ saved: false, reason: "blank" });
    expect(fs.statSync(covers.privateCoverPath(APP)).size).toBeGreaterThan(4000);
  });

  it("stores the approved cover as an App File and serves the CDN url", async () => {
    covers.savePrivateCover(APP, big(), "validate");
    const upload = vi.fn(async () => ({ id: "f1", objectKey: "apps/x/cover.jpg", url: "https://files.papr.ai/apps/x/cover.jpg" }));
    expect(await covers.sharePrivateCover(APP, upload)).toEqual({ shared: true, via: "app_files", url: "https://files.papr.ai/apps/x/cover.jpg" });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ appId: APP, mime: "image/jpeg" }));
    expect(covers.readSharedCoverPointer(APP)?.appFileId).toBe("f1");
    fs.rmSync(covers.privateCoverPath(APP));
    expect(covers.resolveCover(APP)).toEqual({ slot: "shared", redirect: "https://files.papr.ai/apps/x/cover.jpg" });
    expect(covers.removeSharedCover(APP)).toBe(true);
    expect(covers.resolveCover(APP)).toBeNull();
  });

  it("falls back to an inline cover when App Files is unavailable", async () => {
    covers.savePrivateCover(APP, big(), "validate");
    const upload = vi.fn(async () => { throw new Error("no database linked"); });
    expect(await covers.sharePrivateCover(APP, upload)).toEqual({ shared: true, via: "inline" });
  });

  it("only shares when the owner approves, and prefers the viewer's own cover", async () => {
    expect(await covers.sharePrivateCover(APP)).toEqual({ shared: false, reason: "no_cover" });
    covers.savePrivateCover(APP, big(), "validate");
    expect(fs.existsSync(covers.sharedCoverPath(APP))).toBe(false);
    expect((await covers.sharePrivateCover(APP)).shared).toBe(true);
    expect(fs.existsSync(covers.sharedCoverPath(APP))).toBe(true);
    // Text (data URL) so the text-only git sync can carry it, at the app root (not a dotdir).
    expect(fs.readFileSync(covers.sharedCoverPath(APP), "utf8")).toMatch(/^data:image\/jpeg;base64,/);
    expect(covers.sharedCoverPath(APP).endsWith(`${APP}/papr-cover.txt`)).toBe(true);
    // A different user (no private cover) sees the shared one.
    fs.rmSync(covers.privateCoverPath(APP));
    expect(covers.resolveCover(APP)?.slot).toBe("shared");
  });

  it("rejects path-traversal app ids", () => {
    expect(covers.savePrivateCover("../etc", big(), "validate")).toEqual({ saved: false, reason: "invalid_app" });
    expect(covers.resolveCover("../../x")).toBeNull();
  });
});
