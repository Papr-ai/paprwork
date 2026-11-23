/**
 * index.html must only load files that exist. A <script src="app.js"> or
 * <link href="style.css"> pointing at nothing renders a dead, unstyled shell
 * (no JS, browser-default Times) and nothing else reports it — the build
 * passes because esbuild never looks at index.html.
 */
import type { ValidationIssue } from "../services/AppService.js";

const TAG_ATTR =
  /<(script|link)\b[^>]*?\s(src|href)=["']([^"']+)["'][^>]*>/gi;

/** Refs served by the platform or the network, not the app folder. */
function isExternalRef(ref: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(ref) || // http:, https:, data:, blob:
    ref.startsWith("//") ||
    ref.startsWith("/") || // /__papr__/…, /api/…
    ref.startsWith("#")
  );
}

function stripQuery(ref: string): string {
  return ref.replace(/[?#].*$/, "").replace(/^\.\//, "");
}

/** Entry names the gateway rewrites to the dist bundle when one is built. */
const BUNDLE_ENTRY = /^(?:app|main)\.(?:tsx?|jsx?|mjs)$/i;

export function checkMiniAppAssetRefs(
  indexHtml: string,
  existingFiles: ReadonlySet<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const hasEntry = ["app.ts", "app.tsx", "main.ts", "main.tsx"].some((f) =>
    existingFiles.has(f),
  );
  const seen = new Set<string>();
  for (const match of indexHtml.matchAll(TAG_ATTR)) {
    const [tag, kind, , rawRef] = match;
    if (kind.toLowerCase() === "link" && !/rel=["']stylesheet["']/i.test(tag)) {
      continue; // icons, preloads, manifests are not worth failing a build
    }
    if (isExternalRef(rawRef)) continue;
    const ref = stripQuery(rawRef);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);

    if (existingFiles.has(ref)) continue;
    // dist/ output and app.js-style entry names are produced by the bundler.
    if (hasEntry && (ref === "dist/app.js" || BUNDLE_ENTRY.test(ref))) continue;
    if (ref === "dist/app.css") continue; // only exists when the entry imports CSS

    const line = indexHtml.slice(0, match.index ?? 0).split("\n").length;
    const what = kind.toLowerCase() === "script" ? "script" : "stylesheet";
    const cssFiles = [...existingFiles].filter((f) => f.endsWith(".css") && !f.startsWith("dist/"));
    const hint =
      what === "stylesheet" && cssFiles.length > 0
        ? ` Stylesheets in this app: ${cssFiles.join(", ")}.`
        : what === "script" && hasEntry
          ? ' Load the bundle with <script type="module" src="dist/app.js"></script>.'
          : "";
    issues.push({
      file: "index.html",
      line,
      severity: "error",
      message: `index.html loads ${what} "${ref}" but that file does not exist — the page will render without it.${hint}`,
      rule: "missing-asset",
    });
  }
  return issues;
}
