/**
 * Mini-app SDK discovery + route metadata.
 * Routes are auto-registered from files in this directory — add a papr-*.ts
 * module here; override hints below only when conventions are not enough.
 */

import { readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

export type MiniAppSdkFormat = "esm" | "iife";

export interface MiniAppSdkModule {
  file: string;
  route: string;
  format: MiniAppSdkFormat;
  summary: string;
  exports: string;
  appImportable: boolean;
}

export const MINI_APP_SDK_MANIFEST_PATH =
  "src/resources/mini-app-sdk/sdk-manifest.ts";

export const PAPR_SDK_ENTRY_ROUTE = "/__papr__/papr-sdk.ts";

const __filename = fileURLToPath(import.meta.url);
const SDK_DIR = path.dirname(__filename);

/** Never served over HTTP. */
const SKIP_DISCOVERY = new Set(["sdk-manifest.ts"]);

/** Platform-injected or internal — served for bundling, not app imports. */
const PLATFORM_OR_INTERNAL = new Set([
  "papr-native-dialog-shim.ts",
  "papr-auth-guard.ts",
  "papr-auth-ui.ts",
  "papr-version-check.ts",
  "papr-markdown.ts",
  "papr-agent-chat-plan.ts",
]);

/** Legacy script-tag bundles use .js routes + IIFE format. */
const IIFE_JS_ROUTE = new Set([
  "papr-agent-chat.ts",
  ...PLATFORM_OR_INTERNAL,
]);

/** ESM modules that apps import via `.js` URL (bundler convention). */
const ESM_JS_ROUTE = new Set(["papr-files.ts"]);

const AGENT_HINTS: Record<string, Pick<MiniAppSdkModule, "summary" | "exports">> =
  {
    "papr-sdk.ts": {
      summary: "Unified SDK entry — prefer this single import",
      exports: "papr.dialog.*, papr.jobs.*, papr.files.*, papr.preview.*",
    },
    "papr-dialog.ts": {
      summary: "Modal text input / confirm / alert (legacy direct import)",
      exports: "askText, askConfirm, showAlert",
    },
    "papr-job-events.ts": {
      summary: "SSE job + DB live updates",
      exports: "subscribeJobEvents",
    },
    "papr-preview-lifecycle.ts": {
      summary: "Pause pollers when preview tab is backgrounded",
      exports: "onPreviewLifecycle, registerPausablePreviewResource",
    },
    "papr-files.ts": {
      summary: "Large file upload / list / signed URL / remove",
      exports: "papr.files.* (prefer papr-sdk import)",
    },
    "papr-agent-chat.ts": {
      summary: "Embedded assistant bubble script (after enable_app_agent_chat)",
      exports: "<script src=...> auto-mount",
    },
    "papr-native-dialog-shim.ts": {
      summary: "Auto-injected legacy prompt/confirm/alert polyfill",
      exports: "(platform — do not import)",
    },
    "papr-auth-guard.ts": {
      summary: "Auto-injected cloud auth guard",
      exports: "(platform — do not import)",
    },
    "papr-auth-ui.ts": {
      summary: "Auth overlay markup (internal)",
      exports: "(internal)",
    },
    "papr-version-check.ts": {
      summary: "Auto-injected publish revision nudge",
      exports: "(platform — do not import)",
    },
    "papr-markdown.ts": {
      summary: "Markdown helper for agent-chat (internal)",
      exports: "(internal)",
    },
    "papr-agent-chat-plan.ts": {
      summary: "Plan card UI for agent-chat (internal)",
      exports: "(internal)",
    },
  };

function routeForFile(file: string, format: MiniAppSdkFormat): string {
  const base = file.replace(/\.ts$/, "");
  if (ESM_JS_ROUTE.has(file)) {
    return `/__papr__/${base}.js`;
  }
  return `/__papr__/${base}${format === "iife" ? ".js" : ".ts"}`;
}

function formatForFile(file: string): MiniAppSdkFormat {
  if (ESM_JS_ROUTE.has(file)) {
    return "esm";
  }
  return IIFE_JS_ROUTE.has(file) ? "iife" : "esm";
}

/** Static catalog when packaged app is missing copied .ts sources (bad delta update, etc.). */
function fallbackModulesFromHints(): MiniAppSdkModule[] {
  return Object.keys(AGENT_HINTS)
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file) => {
      const format = formatForFile(file);
      const hints = AGENT_HINTS[file]!;
      return {
        file,
        route: routeForFile(file, format),
        format,
        summary: hints.summary,
        exports: hints.exports,
        appImportable: !PLATFORM_OR_INTERNAL.has(file),
      };
    });
}

/** Map on-disk SDK entry (.ts or compiled .js) to canonical manifest name (always *.ts). */
function canonicalSdkFileName(name: string): string | null {
  if (name.endsWith(".d.ts") || name.endsWith(".js.map")) {
    return null;
  }
  if (name.endsWith(".ts") && !SKIP_DISCOVERY.has(name)) {
    return name;
  }
  // Packaged builds may ship only compiled sdk-manifest.js + papr-auth-ui.js
  // beside the .ts sources (auto-update deltas sometimes omit the .ts tree).
  if (name.endsWith(".js") && name.startsWith("papr-")) {
    return `${name.slice(0, -3)}.ts`;
  }
  return null;
}

function discoverMiniAppSdkModules(): MiniAppSdkModule[] {
  const canonicalNames = new Set<string>();
  for (const name of readdirSync(SDK_DIR)) {
    const canonical = canonicalSdkFileName(name);
    if (canonical) {
      canonicalNames.add(canonical);
    }
  }

  const files = [...canonicalNames].sort();

  if (!files.includes("papr-sdk.ts")) {
    console.warn(
      `[MiniAppSdk] papr-sdk.ts not found under ${SDK_DIR} — ` +
        "using static SDK catalog (mini-app /__papr__/ routes may fail until reinstall)",
    );
    return fallbackModulesFromHints();
  }

  return files.map((file) => {
    const format = formatForFile(file);
    const hints = AGENT_HINTS[file] ?? {
      summary: `Mini-app SDK module (${file})`,
      exports: "(see source file)",
    };
    return {
      file,
      route: routeForFile(file, format),
      format,
      summary: hints.summary,
      exports: hints.exports,
      appImportable: !PLATFORM_OR_INTERNAL.has(file),
    };
  });
}

export const MINI_APP_SDK_MODULES: readonly MiniAppSdkModule[] =
  discoverMiniAppSdkModules();

export function getImportableMiniAppSdkModules(): MiniAppSdkModule[] {
  return MINI_APP_SDK_MODULES.filter((module) => module.appImportable);
}

export function getPrimaryMiniAppSdkModule(): MiniAppSdkModule {
  const primary = MINI_APP_SDK_MODULES.find(
    (module) => module.route === PAPR_SDK_ENTRY_ROUTE,
  );
  if (!primary) {
    throw new Error(
      "papr-sdk.ts missing from mini-app SDK discovery " +
        `(scanned ${SDK_DIR}; packaged builds need dist/resources/mini-app-sdk/*.ts or papr-*.js)`,
    );
  }
  return primary;
}
