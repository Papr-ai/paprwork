/**
 * Assemble the full Papr API catalog from HTTP entries, SDK manifest, and agent tools.
 */

import { allTools } from "../tools/index.js";
import {
  getImportableMiniAppSdkModules,
  MINI_APP_SDK_MODULES,
} from "../../resources/mini-app-sdk/sdk-manifest.js";
import { MINI_APP_HTTP_CATALOG_ENTRIES } from "./miniAppHttpEntries.js";
import type { PaprApiCatalog, PaprApiCatalogEntry } from "./types.js";

function toolEntries(): PaprApiCatalogEntry[] {
  return allTools.map((tool) => {
    const description =
      typeof tool.description === "string" ? tool.description : "";
    const tokens = tool.id.split("_").filter((part) => part.length > 1);
    return {
      id: `agent-tool-${tool.id}`,
      title: tool.id,
      summary: description.length > 600 ? `${description.slice(0, 597)}...` : description,
      surfaces: ["agent-tool"],
      runtimes: ["desktop"],
      toolId: tool.id,
      keywords: [tool.id, ...tokens, "tool", "agent"],
      playbookRef:
        tool.id.includes("app") || tool.id.includes("job")
          ? "preloaded-app-and-jobs-guide"
          : tool.id.includes("memory") || tool.id.includes("wiki")
            ? "preloaded-app-and-jobs-guide"
            : undefined,
    };
  });
}

function sdkEntries(): PaprApiCatalogEntry[] {
  return MINI_APP_SDK_MODULES.map((mod) => ({
    id: `sdk-${mod.file.replace(/\.ts$/, "")}`,
    title: mod.file,
    summary: mod.summary,
    surfaces: ["mini-app-sdk"],
    runtimes: ["desktop", "cloud"],
    sdkRoute: mod.route,
    keywords: [
      mod.file,
      mod.route,
      ...mod.exports.split(/[,\s]+/).filter(Boolean),
      "sdk",
      "papr",
      "__papr__",
    ],
    limits: mod.appImportable ? undefined : ["Platform-injected — do not import in app code"],
    example: mod.appImportable
      ? `import { papr } from '${mod.route === "/__papr__/papr-sdk.ts" ? "/__papr__/papr-sdk.ts" : mod.route}';`
      : undefined,
    playbookRef: "preloaded-miniapp-contracts",
  }));
}

function dedupeById(entries: PaprApiCatalogEntry[]): PaprApiCatalogEntry[] {
  const seen = new Map<string, PaprApiCatalogEntry>();
  for (const entry of entries) {
    if (!seen.has(entry.id)) {
      seen.set(entry.id, entry);
    }
  }
  return [...seen.values()];
}

export function buildPaprApiCatalog(): PaprApiCatalog {
  const entries = dedupeById([
    ...MINI_APP_HTTP_CATALOG_ENTRIES,
    ...sdkEntries(),
    ...toolEntries(),
  ]);

  // Stable sort for diffs
  entries.sort((a, b) => a.id.localeCompare(b.id));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    entryCount: entries.length,
    entries,
  };
}

/** Importable SDK modules only — for compact prompt slices */
export function buildImportableSdkSummary(): string {
  return getImportableMiniAppSdkModules()
    .map((m) => `- ${m.route}: ${m.summary}`)
    .join("\n");
}
