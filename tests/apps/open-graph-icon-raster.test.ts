import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  inkSvgForRaster,
  parseCatalogIconDataUri,
  rasterizePreviewIconForOpenGraph,
} from "../../src/gateway/utils/openGraphIconRaster.js";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Real-world app logo shape: no xmlns, stroke="currentColor", fill="none".
const STROKE_LOGO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>`;

describe("openGraphIconRaster", () => {
  it("parses catalog PNG data URIs", () => {
    const parsed = parseCatalogIconDataUri(TINY_PNG);
    expect(parsed?.mime).toBe("image/png");
    expect(parsed?.bytes.length).toBeGreaterThan(0);
  });

  it("resolves currentColor and adds xmlns", () => {
    const out = inkSvgForRaster(STROKE_LOGO);
    expect(out).not.toMatch(/currentColor/i);
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("card is 1200x630, opaque white (never black/transparent on X dark mode)", async () => {
    const { body, contentType } = await rasterizePreviewIconForOpenGraph(STROKE_LOGO, "card");
    expect(contentType).toBe("image/png");
    const { data, info } = await sharp(body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(1200);
    expect(info.height).toBe(630);
    const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4));
    expect(px(0, 0)).toEqual([255, 255, 255, 255]);
    let minAlpha = 255;
    for (let i = 3; i < data.length; i += 4) minAlpha = Math.min(minAlpha, data[i]!);
    expect(minAlpha).toBe(255);
  });

  it("icon is 512x512 and inks the logo (not solid black)", async () => {
    const { body } = await rasterizePreviewIconForOpenGraph(STROKE_LOGO, "icon");
    const { data, info } = await sharp(body).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(512);
    let darkest = 255 * 3;
    for (let i = 0; i < data.length; i += info.channels) darkest = Math.min(darkest, data[i]! + data[i + 1]! + data[i + 2]!);
    expect(darkest).toBeGreaterThan(60); // ink is slate (#5A6274), not black
    expect(darkest).toBeLessThan(600); // but the logo is actually drawn
  });

  it("flattens PNG data URIs onto white", async () => {
    const result = await rasterizePreviewIconForOpenGraph(TINY_PNG, "card");
    expect(result.contentType).toBe("image/png");
    const meta = await sharp(result.body).metadata();
    expect(meta.width).toBe(1200);
  });
});
