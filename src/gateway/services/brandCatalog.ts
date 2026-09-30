/**
 * Discover per-app brand overrides for sleep preflight and brand maintenance.
 */

import { promises as fs } from "fs";
import { getPaprAppsRoot, getPaprDataDir } from "../../core/utils/paprRoot.js";
import path from "path";
import type { BrandTokens } from "../../core/types/brand.js";
import { normalizeBrandTokens } from "./brandNormalize.js";

export interface AppBrandSummary {
  appId: string;
  appTitle: string;
  brand: BrandTokens;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadAppTitles(): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const appsIndexPath = path.join(getPaprDataDir(), "apps.json");

  if (!(await fileExists(appsIndexPath))) {
    return titles;
  }

  try {
    const raw = await fs.readFile(appsIndexPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const entries: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? Object.values(parsed as Record<string, unknown>)
        : [];

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const title =
        typeof record.title === "string"
          ? record.title.trim()
          : typeof record.name === "string"
            ? record.name.trim()
            : "";
      if (id) titles.set(id, title || id);
    }
  } catch {
    /* ignore corrupt index */
  }

  return titles;
}

function brandHasContent(brand: BrandTokens): boolean {
  return Boolean(
    brand.name ||
      brand.voice ||
      brand.colors?.primary ||
      brand.colors?.accent ||
      brand.fonts?.heading ||
      brand.fonts?.body ||
      brand.logo?.light ||
      brand.logo?.dark,
  );
}

/** Scan PAPR_HOME/apps/{appId}/brand.json for configured per-app brands. */
export async function listAppBrandOverrides(): Promise<AppBrandSummary[]> {
  const appsRoot = getPaprAppsRoot();
  if (!(await fileExists(appsRoot))) {
    return [];
  }

  const titles = await loadAppTitles();
  const entries = await fs.readdir(appsRoot, { withFileTypes: true });
  const summaries: AppBrandSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const appId = entry.name;
    const brandPath = path.join(appsRoot, appId, "brand.json");
    if (!(await fileExists(brandPath))) continue;

    try {
      const raw = JSON.parse(await fs.readFile(brandPath, "utf8")) as unknown;
      const brand = normalizeBrandTokens(raw);
      if (!brandHasContent(brand)) continue;

      summaries.push({
        appId,
        appTitle: titles.get(appId) ?? appId,
        brand,
      });
    } catch {
      /* skip unreadable brand files */
    }
  }

  return summaries.sort((a, b) => a.appTitle.localeCompare(b.appTitle));
}

export function formatAppBrandOverridesForSleep(
  overrides: ReadonlyArray<AppBrandSummary>,
): string {
  if (overrides.length === 0) {
    return "_No per-app brand.json overrides found under `$PAPR_HOME/apps/`._";
  }

  return overrides
    .map((entry) => {
      const colors = entry.brand.colors;
      const colorBits = [
        colors?.primary ? `primary ${colors.primary}` : null,
        colors?.accent ? `accent ${colors.accent}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const fonts = entry.brand.fonts;
      const fontBits = [
        fonts?.heading ? `heading ${fonts.heading}` : null,
        fonts?.body ? `body ${fonts.body}` : null,
      ]
        .filter(Boolean)
        .join(", ");

      const details = [colorBits, fontBits, entry.brand.voice ? `voice set` : null]
        .filter(Boolean)
        .join(" · ");

      return `- **${entry.appTitle}** (\`${entry.appId}\`) — \`apps/${entry.appId}/brand.json\`${details ? `: ${details}` : ""}`;
    })
    .join("\n");
}
