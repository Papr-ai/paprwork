/**
 * Prepare mini-app icons for cloud publish (catalogIcon field).
 *
 * The memory server caps catalogIcon at 8,000 characters — enough for inline SVG
 * or a small JPEG thumbnail, not a 512×512 PNG data URI (~50–200KB base64).
 */

import { promises as fs } from "fs";
import path from "path";

/** Must match memory server validation on POST /v1/cloud/apps/publish */
export const CATALOG_ICON_MAX_CHARS = 8000;

const DATA_URI_IMAGE_RE =
  /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([a-z0-9+/=\s]+)$/i;

const APP_DIR_SVG_CANDIDATES = ["logo.svg", "icon.svg", "favicon.svg"] as const;

function normalizeSvgForCatalog(svg: string): string {
  let normalized = svg.trim().replace(/"/g, "'");
  normalized = normalized
    .replace(/width=['"][^'"]*['"]/i, "width='14'")
    .replace(/height=['"][^'"]*['"]/i, "height='14'");
  if (!normalized.includes("width=")) {
    normalized = normalized.replace("<svg", "<svg width='14' height='14'");
  }
  return normalized;
}

async function readAppDirSvgIcon(appDir: string): Promise<string | null> {
  for (const filename of APP_DIR_SVG_CANDIDATES) {
    const filePath = path.join(appDir, filename);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const trimmed = content.trim();
      if (!trimmed.startsWith("<svg") || !trimmed.includes("</svg>")) {
        continue;
      }
      return normalizeSvgForCatalog(trimmed);
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function compressDataUriImage(
  dataUri: string,
  maxChars: number,
): Promise<string | null> {
  const match = dataUri.match(DATA_URI_IMAGE_RE);
  if (!match) {
    return null;
  }

  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.warn(
      "[CloudPublish] sharp unavailable — cannot compress catalog icon data URI",
    );
    return null;
  }

  const input = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  const sizes = [128, 96, 72, 64, 48, 32];
  const qualities = [85, 70, 55, 40, 28];

  for (const size of sizes) {
    for (const quality of qualities) {
      try {
        const out = await sharp(input)
          .resize(size, size, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();
        const candidate = `data:image/jpeg;base64,${out.toString("base64")}`;
        if (candidate.length <= maxChars) {
          return candidate;
        }
      } catch (error) {
        console.warn(
          "[CloudPublish] catalog icon compress failed:",
          (error as Error).message,
        );
        return null;
      }
    }
  }

  return null;
}

export interface PrepareCatalogIconResult {
  icon?: string;
  /** Why the stored icon was transformed or dropped */
  note?: string;
}

/**
 * Returns a catalogIcon safe to send to the cloud publish API, or undefined to omit.
 */
export async function prepareCatalogIconForPublish(args: {
  icon?: string | null;
  appDir?: string;
  maxChars?: number;
}): Promise<PrepareCatalogIconResult> {
  const maxChars = args.maxChars ?? CATALOG_ICON_MAX_CHARS;
  const trimmed = args.icon?.trim();

  if (trimmed && trimmed.length <= maxChars) {
    return { icon: trimmed };
  }

  if (trimmed) {
    if (trimmed.startsWith("data:image/")) {
      const compressed = await compressDataUriImage(trimmed, maxChars);
      if (compressed) {
        return {
          icon: compressed,
          note: `compressed catalog icon ${trimmed.length}→${compressed.length} chars`,
        };
      }
    }

    if (trimmed.startsWith("<") && trimmed.includes("</svg>")) {
      const normalized = normalizeSvgForCatalog(trimmed);
      if (normalized.length <= maxChars) {
        return {
          icon: normalized,
          note: `normalized SVG catalog icon ${trimmed.length}→${normalized.length} chars`,
        };
      }
    }
  }

  if (args.appDir) {
    const svg = await readAppDirSvgIcon(args.appDir);
    if (svg && svg.length <= maxChars) {
      return {
        icon: svg,
        note: trimmed
          ? `used ${args.appDir} SVG fallback (${trimmed.length} chars exceeded limit)`
          : undefined,
      };
    }
  }

  if (trimmed) {
    console.warn(
      `[CloudPublish] Omitting catalogIcon (${trimmed.length} chars > ${maxChars}). ` +
        "Publish will succeed without a community thumbnail.",
    );
    return {
      note: `catalogIcon omitted (${trimmed.length} chars exceeds ${maxChars})`,
    };
  }

  return {};
}
