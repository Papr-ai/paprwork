/**
 * Validates mini-app icons for the Papr droplet design system.
 * Inline SVGs must be transparent (stroke-only) — the UI adds the glass orb.
 * PNG/data-URI icons must include the full droplet in the asset itself.
 */

export type MiniAppIconValidationResult =
  | { ok: true }
  | { ok: false; message: string; rule: "icon-format" | "svg-background" };

const TRANSPARENT_FILLS = new Set(["none", "transparent", "currentcolor"]);

function isImageIcon(icon: string): boolean {
  return icon.startsWith("data:image/") || /^https?:\/\//i.test(icon);
}

function parseViewBox(svg: string): { width: number; height: number } {
  const viewBoxMatch = svg.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1]
      .trim()
      .split(/[\s,]+/)
      .map((part) => Number(part));
    if (parts.length === 4 && parts.every((value) => !Number.isNaN(value))) {
      return { width: parts[2], height: parts[3] };
    }
  }

  const widthMatch = svg.match(/\bwidth\s*=\s*["']([\d.]+)/i);
  const heightMatch = svg.match(/\bheight\s*=\s*["']([\d.]+)/i);
  if (widthMatch && heightMatch) {
    return {
      width: Number(widthMatch[1]),
      height: Number(heightMatch[1]),
    };
  }

  return { width: 24, height: 24 };
}

function parseFillValue(tag: string): string | null {
  const fillAttr = tag.match(/\bfill\s*=\s*["']([^"']*)["']/i);
  if (fillAttr) {
    return fillAttr[1].trim();
  }

  const styleFill = tag.match(/\bfill\s*:\s*([^;"']+)/i);
  if (styleFill) {
    return styleFill[1].trim();
  }

  return null;
}

function isOpaqueFill(fill: string | null): boolean {
  if (fill === null) {
    return false;
  }

  const normalized = fill.toLowerCase().trim();
  if (TRANSPARENT_FILLS.has(normalized)) {
    return false;
  }

  return true;
}

function isLightBackgroundFill(fill: string): boolean {
  const normalized = fill.toLowerCase().trim();
  if (
    normalized === "white" ||
    normalized === "#fff" ||
    normalized === "#ffffff" ||
    normalized.startsWith("rgb(255") ||
    normalized.startsWith("rgba(255")
  ) {
    return true;
  }

  if (/^#f{3,8}$/i.test(normalized)) {
    return true;
  }

  return false;
}

function getSvgBackgroundIssue(svg: string): string | null {
  const { width, height } = parseViewBox(svg);
  const minDim = Math.min(width, height);
  const largeShapeThreshold = minDim * 0.65;
  const largeCircleThreshold = minDim * 0.35;

  const circleTags = svg.match(/<circle\b[^>]*>/gi) ?? [];
  for (const tag of circleTags) {
    const fill = parseFillValue(tag);
    if (!isOpaqueFill(fill)) {
      continue;
    }

    const radiusMatch = tag.match(/\br\s*=\s*["']([\d.]+)/i);
    const radius = radiusMatch ? Number(radiusMatch[1]) : 0;
    const fillValue = fill ?? "";

    if (radius >= largeCircleThreshold) {
      return (
        "SVG icon includes a large filled circle background. Remove background shapes — " +
        "use stroke-only paths with fill=\"none\"; Paprwork renders SVG icons inside the liquid-glass orb."
      );
    }

    if (isLightBackgroundFill(fillValue) && radius >= minDim * 0.2) {
      return (
        "SVG icon includes a white/light filled circle background. Use a transparent background — " +
        "stroke=\"currentColor\" and fill=\"none\" only; the UI adds the glass bubble."
      );
    }

    if (fillValue.toLowerCase().startsWith("url(")) {
      return (
        "SVG icon uses a gradient-filled circle (flat orb style). Remove background orbs — " +
        "use stroke-only SVG markup, or pass a 512×512 droplet PNG via data:image/png;base64,..."
      );
    }
  }

  const rectTags = svg.match(/<rect\b[^>]*>/gi) ?? [];
  for (const tag of rectTags) {
    const fill = parseFillValue(tag);
    if (!isOpaqueFill(fill)) {
      continue;
    }

    const widthMatch = tag.match(/\bwidth\s*=\s*["']([\d.]+)/i);
    const heightMatch = tag.match(/\bheight\s*=\s*["']([\d.]+)/i);
    const rectWidth = widthMatch ? Number(widthMatch[1]) : 0;
    const rectHeight = heightMatch ? Number(heightMatch[1]) : 0;

    if (rectWidth >= largeShapeThreshold && rectHeight >= largeShapeThreshold) {
      const fillValue = fill ?? "";
      if (isLightBackgroundFill(fillValue) || fillValue.toLowerCase().startsWith("url(")) {
        return (
          "SVG icon includes a large filled rectangle background. Remove background shapes — " +
          "use stroke-only paths with fill=\"none\"; Paprwork renders SVG icons inside the liquid-glass orb."
        );
      }
    }
  }

  if (/<radialGradient/i.test(svg) && /<circle[^>]*fill\s*=\s*["']url\(#/i.test(svg)) {
    return (
      "SVG icon uses a radial-gradient orb background. Remove the gradient orb — " +
      "use stroke-only SVG markup, or pass a 512×512 droplet PNG via data:image/png;base64,..."
    );
  }

  return null;
}

export function validateMiniAppIcon(icon: string): MiniAppIconValidationResult {
  const trimmed = icon.trim();
  if (!trimmed) {
    return {
      ok: false,
      rule: "icon-format",
      message: "Icon is required for mini-apps.",
    };
  }

  if (isImageIcon(trimmed)) {
    return { ok: true };
  }

  if (!trimmed.startsWith("<")) {
    return {
      ok: false,
      rule: "icon-format",
      message:
        'Icon must be inline SVG (starting with "<") or a PNG/JPEG data URI / https URL. ' +
        "Plain text and emojis are not allowed.",
    };
  }

  const backgroundIssue = getSvgBackgroundIssue(trimmed);
  if (backgroundIssue) {
    return {
      ok: false,
      rule: "svg-background",
      message: backgroundIssue,
    };
  }

  return { ok: true };
}

/** Returns a trimmed icon when valid, or null so callers can fall back to the default orb. */
export function sanitizeMiniAppIcon(icon: string | null | undefined): string | null {
  if (!icon?.trim()) {
    return null;
  }
  const trimmed = icon.trim();
  const result = validateMiniAppIcon(trimmed);
  return result.ok ? trimmed : null;
}

export function assertValidMiniAppIcon(icon: string): void {
  const result = validateMiniAppIcon(icon);
  if (!result.ok) {
    throw new Error(result.message);
  }
}
