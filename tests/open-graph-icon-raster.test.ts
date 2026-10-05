import { describe, expect, it } from "vitest";
import {
  parseCatalogIconDataUri,
  rasterizePreviewIconForOpenGraph,
} from "../src/gateway/utils/openGraphIconRaster.js";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("openGraphIconRaster", () => {
  it("parses catalog PNG data URIs", () => {
    const parsed = parseCatalogIconDataUri(TINY_PNG);
    expect(parsed?.mime).toBe("image/png");
    expect(parsed?.bytes.length).toBeGreaterThan(0);
  });

  it("returns PNG bytes for SVG input when sharp is available", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#0060E0"/></svg>`;
    const result = await rasterizePreviewIconForOpenGraph(svg);
    if (result.contentType === "image/png") {
      expect(result.body.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    } else {
      expect(result.contentType).toContain("svg");
    }
  });

  it("passes through PNG data URIs unchanged", async () => {
    const result = await rasterizePreviewIconForOpenGraph(TINY_PNG);
    expect(result.contentType).toBe("image/png");
    expect(result.body.length).toBeGreaterThan(10);
  });
});
