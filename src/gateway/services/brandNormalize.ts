/**
 * Normalize brand.json shapes (legacy agent output → canonical BrandTokens).
 */

import type {
  BrandColors,
  BrandFonts,
  BrandLogo,
  BrandSource,
  BrandTokens,
} from "../../core/types/brand.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  return readString(obj[key]);
}

/** Canonical brand.json example for agents (workspace + per-app). */
export const BRAND_JSON_CANONICAL_EXAMPLE = `{
  "name": "Acme Inc.",
  "colors": {
    "primary": "#0161E0",
    "accent": "#0CCDFF",
    "background": "#FFFFFF",
    "text": "#131417"
  },
  "fonts": {
    "heading": "Inter, sans-serif",
    "body": "Inter, sans-serif"
  },
  "logo": {
    "light": "brand/logo.svg",
    "dark": "brand/logo-dark.svg"
  },
  "voice": "Professional, concise, friendly",
  "sources": [
    { "date": "2026-08-25", "chat": "Onboarding", "note": "User provided color swatches" }
  ]
}`;

/** Accepts canonical BrandTokens or legacy keys (companyName, typography, backgroundLight, …). */
export function normalizeBrandTokens(raw: unknown): BrandTokens {
  if (!isRecord(raw)) {
    return {};
  }

  const name =
    readStringField(raw, "name") ?? readStringField(raw, "companyName");

  const colorsRaw = isRecord(raw.colors) ? raw.colors : undefined;
  const typographyRaw = isRecord(raw.typography) ? raw.typography : undefined;
  const fontsRaw = isRecord(raw.fonts) ? raw.fonts : undefined;
  const logoRaw = isRecord(raw.logo) ? raw.logo : undefined;

  const colors: BrandColors = {};
  if (colorsRaw) {
    const primary = readStringField(colorsRaw, "primary");
    const accent = readStringField(colorsRaw, "accent");
    const background =
      readStringField(colorsRaw, "background") ??
      readStringField(colorsRaw, "backgroundLight");
    const text =
      readStringField(colorsRaw, "text") ??
      readStringField(colorsRaw, "textLight");
    if (primary) colors.primary = primary;
    if (accent) colors.accent = accent;
    if (background) colors.background = background;
    if (text) colors.text = text;
  }

  const fonts: BrandFonts = {};
  const heading =
    (fontsRaw ? readStringField(fontsRaw, "heading") : undefined) ??
    (typographyRaw ? readStringField(typographyRaw, "headings") : undefined) ??
    (typographyRaw ? readStringField(typographyRaw, "heading") : undefined);
  const body =
    (fontsRaw ? readStringField(fontsRaw, "body") : undefined) ??
    (typographyRaw ? readStringField(typographyRaw, "body") : undefined);
  if (heading) fonts.heading = heading;
  if (body) fonts.body = body;

  const logo: BrandLogo = {};
  if (logoRaw) {
    const light = readStringField(logoRaw, "light");
    const dark = readStringField(logoRaw, "dark");
    if (light) logo.light = light;
    if (dark) logo.dark = dark;
  }

  const voice = readStringField(raw, "voice");

  let sources: BrandSource[] | undefined;
  if (Array.isArray(raw.sources)) {
    sources = raw.sources
      .filter(isRecord)
      .map((entry) => ({
        date: readStringField(entry, "date") ?? "",
        chat: readStringField(entry, "chat"),
        appId: readStringField(entry, "appId"),
        note: readStringField(entry, "note") ?? "",
      }))
      .filter((entry) => entry.date.length > 0 || entry.note.length > 0);
  }

  const result: BrandTokens = {};
  if (name) result.name = name;
  if (Object.keys(colors).length > 0) result.colors = colors;
  if (Object.keys(fonts).length > 0) result.fonts = fonts;
  if (Object.keys(logo).length > 0) result.logo = logo;
  if (voice) result.voice = voice;
  if (sources && sources.length > 0) result.sources = sources;

  return result;
}

/** True when JSON uses legacy keys that normalizeBrandTokens would remap. */
export function brandJsonNeedsNormalization(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false;
  }
  if ("companyName" in raw || "typography" in raw) {
    return true;
  }
  if (!isRecord(raw.colors)) {
    return false;
  }
  return (
    "backgroundLight" in raw.colors ||
    "textLight" in raw.colors ||
    "backgroundDark" in raw.colors ||
    "textDark" in raw.colors ||
    "highlight" in raw.colors ||
    "gradient" in raw.colors
  );
}
