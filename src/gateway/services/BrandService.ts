/**
 * BrandService — load and merge global + per-app brand tokens for mini-apps.
 *
 * Global: ~/Papr/workspace/brand.json + BRAND.md + brand/ assets
 * Per-app: ~/Papr/apps/{appId}/brand.json + brand/ assets
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type {
  BrandColors,
  BrandFonts,
  BrandLogo,
  BrandTokens,
} from "../../core/types/brand.js";
import { EMPTY_BRAND_TOKENS } from "../../core/types/brand.js";

export type { BrandTokens } from "../../core/types/brand.js";

export interface ResolvedBrand extends BrandTokens {
  /** CSS custom properties ready for injection into mini-app HTML */
  cssVariables: Record<string, string>;
}

function workspaceDir(): string {
  return path.join(os.homedir(), "Papr", "workspace");
}

function appsDir(): string {
  return path.join(os.homedir(), "Papr", "apps");
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function mergeStringField(
  base: string | undefined,
  override: string | undefined,
): string | undefined {
  return isNonEmpty(override) ? override.trim() : base;
}

function mergeColors(
  base: BrandColors | undefined,
  override: BrandColors | undefined,
): BrandColors | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    primary: mergeStringField(base?.primary, override?.primary),
    accent: mergeStringField(base?.accent, override?.accent),
    background: mergeStringField(base?.background, override?.background),
    text: mergeStringField(base?.text, override?.text),
  };
}

function mergeFonts(
  base: BrandFonts | undefined,
  override: BrandFonts | undefined,
): BrandFonts | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    heading: mergeStringField(base?.heading, override?.heading),
    body: mergeStringField(base?.body, override?.body),
  };
}

function mergeLogo(
  base: BrandLogo | undefined,
  override: BrandLogo | undefined,
): BrandLogo | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    light: mergeStringField(base?.light, override?.light),
    dark: mergeStringField(base?.dark, override?.dark),
  };
}

/** Merge app-specific brand over global defaults (app wins per field). */
export function mergeBrandTokens(
  globalBrand: BrandTokens,
  appBrand: BrandTokens | null,
): BrandTokens {
  if (!appBrand) {
    return { ...globalBrand };
  }

  return {
    name: mergeStringField(globalBrand.name, appBrand.name) ?? globalBrand.name,
    colors: mergeColors(globalBrand.colors, appBrand.colors),
    fonts: mergeFonts(globalBrand.fonts, appBrand.fonts),
    logo: mergeLogo(globalBrand.logo, appBrand.logo),
    voice: mergeStringField(globalBrand.voice, appBrand.voice) ?? globalBrand.voice,
    sources: [
      ...(globalBrand.sources ?? []),
      ...(appBrand.sources ?? []),
    ],
  };
}

function stripEmptyBrandFields(tokens: BrandTokens): BrandTokens {
  const result: BrandTokens = {};

  if (isNonEmpty(tokens.name)) {
    result.name = tokens.name.trim();
  }

  const colors = tokens.colors;
  if (colors) {
    const cleaned: BrandColors = {};
    if (isNonEmpty(colors.primary)) cleaned.primary = colors.primary.trim();
    if (isNonEmpty(colors.accent)) cleaned.accent = colors.accent.trim();
    if (isNonEmpty(colors.background)) cleaned.background = colors.background.trim();
    if (isNonEmpty(colors.text)) cleaned.text = colors.text.trim();
    if (Object.keys(cleaned).length > 0) {
      result.colors = cleaned;
    }
  }

  const fonts = tokens.fonts;
  if (fonts) {
    const cleaned: BrandFonts = {};
    if (isNonEmpty(fonts.heading)) cleaned.heading = fonts.heading.trim();
    if (isNonEmpty(fonts.body)) cleaned.body = fonts.body.trim();
    if (Object.keys(cleaned).length > 0) {
      result.fonts = cleaned;
    }
  }

  const logo = tokens.logo;
  if (logo) {
    const cleaned: BrandLogo = {};
    if (isNonEmpty(logo.light)) cleaned.light = logo.light.trim();
    if (isNonEmpty(logo.dark)) cleaned.dark = logo.dark.trim();
    if (Object.keys(cleaned).length > 0) {
      result.logo = cleaned;
    }
  }

  if (isNonEmpty(tokens.voice)) {
    result.voice = tokens.voice.trim();
  }

  if (tokens.sources && tokens.sources.length > 0) {
    result.sources = tokens.sources;
  }

  return result;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readBrandJsonFile(filePath: string): Promise<BrandTokens | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as BrandTokens;
    const cleaned = stripEmptyBrandFields(parsed);
    return Object.keys(cleaned).length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

export function buildBrandCssVariables(brand: BrandTokens): Record<string, string> {
  const vars: Record<string, string> = {};
  const colors = brand.colors;

  if (colors?.primary) vars["--brand-primary"] = colors.primary;
  if (colors?.accent) vars["--brand-accent"] = colors.accent;
  if (colors?.background) vars["--brand-background"] = colors.background;
  if (colors?.text) vars["--brand-text"] = colors.text;

  const fonts = brand.fonts;
  if (fonts?.heading) vars["--brand-font-heading"] = fonts.heading;
  if (fonts?.body) vars["--brand-font-body"] = fonts.body;

  return vars;
}

export function buildBrandStyleTag(cssVariables: Record<string, string>): string {
  if (Object.keys(cssVariables).length === 0) {
    return "";
  }

  const declarations = Object.entries(cssVariables)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join("\n");

  return `<style data-paprwork-brand>
:root {
${declarations}
}
</style>`;
}

/** Resolve logo paths to gateway URLs mini-apps can fetch. */
export function resolveBrandLogoUrls(
  brand: BrandTokens,
  appId?: string,
): BrandTokens {
  const logo = brand.logo;
  if (!logo) {
    return brand;
  }

  const query = appId ? `?appId=${encodeURIComponent(appId)}` : "";

  const resolveOne = (value: string | undefined): string | undefined => {
    if (!isNonEmpty(value)) {
      return undefined;
    }
    if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("data:")) {
      return value;
    }
    const filename = path.basename(value);
    return `/api/brand/assets/${encodeURIComponent(filename)}${query}`;
  };

  return {
    ...brand,
    logo: {
      light: resolveOne(logo.light),
      dark: resolveOne(logo.dark),
    },
  };
}

export class BrandService {
  getWorkspaceDir(): string {
    return workspaceDir();
  }

  getGlobalBrandJsonPath(): string {
    return path.join(workspaceDir(), "brand.json");
  }

  getAppBrandJsonPath(appId: string): string {
    return path.join(appsDir(), appId, "brand.json");
  }

  async loadGlobalBrand(): Promise<BrandTokens> {
    const loaded = await readBrandJsonFile(this.getGlobalBrandJsonPath());
    return loaded ?? { ...EMPTY_BRAND_TOKENS };
  }

  async loadAppBrand(appId: string): Promise<BrandTokens | null> {
    return readBrandJsonFile(this.getAppBrandJsonPath(appId));
  }

  async loadMergedBrand(appId?: string): Promise<ResolvedBrand> {
    const globalBrand = await this.loadGlobalBrand();
    const appBrand = appId ? await this.loadAppBrand(appId) : null;
    const merged = mergeBrandTokens(globalBrand, appBrand);
    const cssVariables = buildBrandCssVariables(merged);

    return {
      ...resolveBrandLogoUrls(merged, appId),
      cssVariables,
    };
  }

  /**
   * Resolve a brand asset file on disk (app brand/ first, then workspace brand/).
   */
  async resolveAssetPath(
    filename: string,
    appId?: string,
  ): Promise<string | null> {
    const safeName = path.basename(filename);
    if (!safeName || safeName !== filename) {
      return null;
    }

    const candidates: string[] = [];
    if (appId) {
      candidates.push(path.join(appsDir(), appId, "brand", safeName));
    }
    candidates.push(path.join(workspaceDir(), "brand", safeName));

    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        return candidate;
      }
    }

    return null;
  }
}

let brandServiceInstance: BrandService | null = null;

export function getBrandService(): BrandService {
  if (!brandServiceInstance) {
    brandServiceInstance = new BrandService();
  }
  return brandServiceInstance;
}
