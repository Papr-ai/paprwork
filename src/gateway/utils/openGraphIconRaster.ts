/**
 * Rasterize mini-app icons for link previews (Slack, iMessage, etc.).
 * Crawlers generally ignore SVG for og:image.
 */

const DATA_URI_IMAGE_RE =
  /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([a-z0-9+/=\s]+)$/i;

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

export async function rasterizePreviewIconForOpenGraph(
  iconSource: string,
): Promise<{ body: Buffer; contentType: string }> {
  const dataUri = parseCatalogIconDataUri(iconSource);
  if (dataUri) {
    if (dataUri.mime === "image/png") {
      return { body: dataUri.bytes, contentType: "image/png" };
    }
    if (dataUri.mime === "image/jpeg" || dataUri.mime === "image/jpg") {
      return { body: dataUri.bytes, contentType: "image/jpeg" };
    }
  }

  let sharp: typeof import("sharp").default;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return {
      body: Buffer.from(iconSource.trim(), "utf8"),
      contentType: "image/svg+xml; charset=utf-8",
    };
  }

  const input = dataUri?.bytes ?? Buffer.from(iconSource.trim(), "utf8");
  const png = await sharp(input, dataUri ? undefined : { density: 192 })
    .resize(512, 512, {
      fit: "contain",
      background: { r: 245, g: 245, b: 247, alpha: 1 },
    })
    .png()
    .toBuffer();

  return { body: png, contentType: "image/png" };
}
