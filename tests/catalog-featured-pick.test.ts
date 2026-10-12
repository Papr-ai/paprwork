import { describe, expect, it } from "vitest";
import { pickFeaturedCatalogEntry } from "../ui/components/Apps/CatalogFeatured";
import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog";

const e = (id: string, extra: Partial<CommunityCatalogEntry> = {}): CommunityCatalogEntry => ({
  catalogId: `cloud:${id}`, source: "cloud", name: id, description: `${id} app`, version: "cloud",
  author: "Papr", tags: [], codeInstallable: true, liveViewable: true, ...extra,
});

describe("pickFeaturedCatalogEntry", () => {
  it("needs at least four candidates", () => {
    expect(pickFeaturedCatalogEntry([e("a"), e("b"), e("c")])).toBeNull();
  });
  it("prefers a publisher headline, then installs", () => {
    const list = [e("a", { installCount: 90 }), e("b", { installCount: 5, headline: "Big line" }), e("c"), e("d")];
    expect(pickFeaturedCatalogEntry(list)?.catalogId).toBe("cloud:b");
    expect(pickFeaturedCatalogEntry(list.map((x) => ({ ...x, headline: undefined })))?.catalogId).toBe("cloud:a");
  });
  it("never features your own or non-installable apps", () => {
    const list = [e("mine", { isOwned: true, installCount: 999 }), e("web", { codeInstallable: false, installCount: 500 }), e("c", { installCount: 3 }), e("d"), e("f"), e("g")];
    expect(pickFeaturedCatalogEntry(list)?.catalogId).toBe("cloud:c");
  });
});
