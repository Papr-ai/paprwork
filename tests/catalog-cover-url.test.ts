import { describe, expect, it } from "vitest";
import { catalogCoverUrl, catalogCoverVideoUrl } from "../ui/utils/catalogPreviewUrl";
import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog";

const base = { catalogId: "cloud:a1", source: "cloud", name: "Leadership Sync", description: "", version: "cloud", author: "Amir", tags: [], appId: "a1" } as unknown as CommunityCatalogEntry;
const IMG = "https://files.papr.ai/apps/a1/preview.jpg";
const VID = "https://files.papr.ai/apps/a1/preview.mp4";

describe("catalog cover links from the catalog record", () => {
  it("uses the stored cover and video directly", () => {
    const e = { ...base, coverUrl: IMG, coverVideoUrl: VID };
    expect(catalogCoverUrl(e)).toBe(IMG);
    expect(catalogCoverVideoUrl(e, IMG)).toBe(VID);
  });
  it("stored picture without a video → no video request", () => {
    const e = { ...base, coverUrl: IMG };
    expect(catalogCoverVideoUrl(e, catalogCoverUrl(e))).toBeNull();
  });
  it("falls back to the legacy papr-cover-video route", () => {
    expect(catalogCoverVideoUrl(base, "https://apps.papr.ai/ns/s/papr-cover")).toBe("https://apps.papr.ai/ns/s/papr-cover-video");
    expect(catalogCoverVideoUrl(base, null)).toBeNull();
  });
});

import { catalogMediaFields } from "../src/gateway/services/CommunityCatalogService";
describe("catalogMedia → card cover", () => {
  const V = "https://files.papr.ai/a/p.mp4", P = "https://files.papr.ai/a/p.jpg", G = "https://files.papr.ai/a/g.png";
  it("video cover gives poster + loop, gallery kept in order", () => {
    const r = catalogMediaFields([{ kind: "video", url: V, role: "cover", posterUrl: P }, { kind: "image", url: G, role: "gallery" }]);
    expect(r.coverUrl).toBe(P);
    expect(r.coverVideoUrl).toBe(V);
    expect(r.media?.map((m) => m.url)).toEqual([V, G]);
  });
  it("image cover, junk dropped, nothing → empty", () => {
    expect(catalogMediaFields([{ kind: "gif", url: G }, { kind: "image", url: "http://x", role: "cover" }, { kind: "image", url: P, role: "cover" }])).toMatchObject({ coverUrl: P });
    expect(catalogMediaFields(undefined)).toEqual({});
    expect(catalogMediaFields([{ kind: "image", url: G }]).coverUrl).toBeUndefined();
  });
});
