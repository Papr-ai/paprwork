import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-refs-"));
vi.mock("../../src/core/utils/paprRoot.js", async (orig) => ({
  ...(await orig<typeof import("../../src/core/utils/paprRoot.js")>()),
  getPaprAppsRoot: () => path.join(root, "apps"),
  getPaprDataDir: () => path.join(root, "data"),
}));

const APP = "a1";
const write = (obj: unknown) => {
  fs.mkdirSync(path.join(root, "apps", APP), { recursive: true });
  fs.writeFileSync(path.join(root, "apps", APP, "papr-cover.json"), JSON.stringify(obj));
};

describe("catalog media is sent as App Files references, never as public links", () => {
  beforeEach(() => fs.rmSync(path.join(root, "apps"), { recursive: true, force: true }));
  afterEach(() => vi.resetModules());

  it("video cover → object keys for video + poster, no url", async () => {
    write({ appFileId: "p", objectKey: "namespaces/n/apps/a1/files/poster", url: "https://files.papr.ai/x", kind: "video", videoUrl: "https://files.papr.ai/y", videoFileId: "v", videoObjectKey: "namespaces/n/apps/a1/files/video" });
    const { sharedCoverCatalogFields } = await import("../../src/gateway/services/CloudAppPublishService.js");
    expect(sharedCoverCatalogFields(APP).catalogMedia).toEqual([
      { kind: "video", role: "cover", objectKey: "namespaces/n/apps/a1/files/video", posterObjectKey: "namespaces/n/apps/a1/files/poster" },
    ]);
  });

  it("image cover → one image reference", async () => {
    write({ appFileId: "p", objectKey: "namespaces/n/apps/a1/files/img", url: "https://files.papr.ai/x" });
    const { sharedCoverCatalogFields } = await import("../../src/gateway/services/CloudAppPublishService.js");
    expect(sharedCoverCatalogFields(APP).catalogMedia).toEqual([{ kind: "image", role: "cover", objectKey: "namespaces/n/apps/a1/files/img" }]);
  });

  it("no shared cover → [] so memory clears stale media", async () => {
    const { sharedCoverCatalogFields } = await import("../../src/gateway/services/CloudAppPublishService.js");
    expect(sharedCoverCatalogFields(APP).catalogMedia).toEqual([]);
  });
});
