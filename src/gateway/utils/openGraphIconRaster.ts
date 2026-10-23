/**
 * Rasterize mini-app icons for link previews (Slack, X, iMessage, etc.).
 * Crawlers ignore SVG for og:image, and they don't know about CSS `currentColor`
 * or our glass-droplet chrome — so we bake both into a PNG here:
 *
 *  - stroke/line SVG logos (fill="none" stroke="currentColor") are inked with the
 *    same color the desktop uses inside the droplet and placed inside the Papr droplet
 *  - full droplet PNG icons (512×512 data URIs) are shown as-is
 *  - everything sits on an opaque white background (transparent PNGs render black
 *    on X dark mode, which is how the "black card" bug happened)
 *
 * Two shapes:
 *  - "icon"  512×512   → favicon / apple-touch-icon
 *  - "card"  1200×630  → og:image / twitter:image (summary_large_image is 1.91:1;
 *                         a square gets center-cropped on X)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_URI_IMAGE_RE =
  /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([a-z0-9+/=\s]+)$/i;

/** Same ink as `.ah-drop` / AppCard orb on light backgrounds (rgba(55,65,88,.78) on white). */
export const OG_ICON_INK = "#5A6274";
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 } as const;

export type OpenGraphShape = "icon" | "card";

export function parseCatalogIconDataUri(
  icon: string,
): { mime: string; bytes: Buffer } | null {
  const match = icon.trim().match(DATA_URI_IMAGE_RE);
  if (!match) {
    return null;
  }
  return {
    mime: match[1].toLowerCase(),
    bytes: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
  };
}

/** Resolve `currentColor` and add xmlns so librsvg renders the logo with real ink. */
export function inkSvgForRaster(svg: string, ink = OG_ICON_INK): string {
  let out = svg.trim().replace(/currentColor/gi, ink);
  if (!/^<svg[^>]*\sxmlns=/i.test(out)) {
    out = out.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  // Root without an explicit stroke/fill still needs ink for bare <path>s.
  if (!/^<svg[^>]*\s(stroke|fill)=/i.test(out)) {
    out = out.replace(/^<svg/i, `<svg fill="${ink}"`);
  }
  return out;
}

let dropletCache: Buffer | null | undefined;

function loadDroplet(): Buffer | null {
  if (dropletCache !== undefined) {
    return dropletCache;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "../../resources/og/droplet.png"),
    path.join(here, "../../../src/resources/og/droplet.png"),
    path.join(process.cwd(), "src/resources/og/droplet.png"),
    path.join(process.cwd(), "dist/resources/og/droplet.png"),
  ].map((p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`));
  for (const p of candidates) {
    try {
      dropletCache = fs.readFileSync(p);
      return dropletCache;
    } catch {
      // try next
    }
  }
  dropletCache = null;
  return null;
}

function canvasSize(shape: OpenGraphShape): { w: number; h: number; art: number } {
  return shape === "card" ? { w: 1200, h: 630, art: 470 } : { w: 512, h: 512, art: 448 };
}

export async function rasterizePreviewIconForOpenGraph(
  iconSource: string,
  shape: OpenGraphShape = "icon",
): Promise<{ body: Buffer; contentType: string }> {
  const dataUri = parseCatalogIconDataUri(iconSource);

  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default;
  } catch {
    if (dataUri && (dataUri.mime === "image/png" || dataUri.mime.startsWith("image/jp"))) {
      return { body: dataUri.bytes, contentType: dataUri.mime === "image/png" ? "image/png" : "image/jpeg" };
    }
    return {
      body: Buffer.from(inkSvgForRaster(iconSource), "utf8"),
      contentType: "image/svg+xml; charset=utf-8",
    };
  }

  const { w, h, art } = canvasSize(shape);
  let artPng: Buffer;

  if (dataUri) {
    // Full droplet renders / photos: show as-is, flattened onto white.
    artPng = await sharp(dataUri.bytes)
      .resize(art, art, { fit: "contain", background: { ...WHITE, alpha: 0 } })
      .png()
      .toBuffer();
  } else {
    const svg = Buffer.from(inkSvgForRaster(iconSource), "utf8");
    const droplet = loadDroplet();
    const glyphSize = Math.round(art * (droplet ? 0.46 : 0.7));
    const glyph = await sharp(svg, { density: 384 })
      .resize(glyphSize, glyphSize, { fit: "contain", background: { ...WHITE, alpha: 0 } })
      .png()
      .toBuffer();
    if (droplet) {
      const shell = await sharp(droplet)
        .resize(art, art, { fit: "contain", background: { ...WHITE, alpha: 0 } })
        .png()
        .toBuffer();
      artPng = await sharp(shell)
        .composite([{ input: glyph, gravity: "center" }])
        .png()
        .toBuffer();
    } else {
      artPng = glyph;
    }
  }

  const png = await sharp({ create: { width: w, height: h, channels: 4, background: WHITE } })
    .composite([{ input: artPng, gravity: "center" }])
    .flatten({ background: WHITE })
    .png()
    .toBuffer();

  return { body: png, contentType: "image/png" };
}
