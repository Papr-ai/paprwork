import path from "path";
import { promises as fs } from "fs";

export interface MiniAppBuildError {
  file: string;
  line?: number;
  column?: number;
  message: string;
  severity: "error" | "warning";
}

export interface MiniAppBuildResult {
  success: boolean;
  errors: MiniAppBuildError[];
  outputFiles: string[];
  /** True when app uses legacy multi-script pattern (no ES module entry). */
  legacy: boolean;
}

/**
 * Detect whether an app uses the bundled architecture (single app.ts entry with imports)
 * vs legacy multi-<script> pattern. Only bundled apps go through esbuild.build().
 */
async function detectBundledApp(appDir: string): Promise<string | null> {
  const candidates = ["app.ts", "app.tsx", "main.ts", "main.tsx"];
  for (const candidate of candidates) {
    const entryPath = path.join(appDir, candidate);
    try {
      const content = await fs.readFile(entryPath, "utf-8");
      if (/\bimport\s/.test(content)) {
        return candidate;
      }
    } catch {
      // File doesn't exist
    }
  }
  return null;
}

/**
 * Build a mini-app using esbuild.build() — resolves the full import graph
 * including CSS imports. Produces dist/app.js + dist/app.css.
 *
 * Returns structured build errors that replace regex-based CSS validation.
 * Missing CSS file → real error. CSS syntax error → real error.
 */
export async function buildMiniApp(appDir: string): Promise<MiniAppBuildResult> {
  const entryFile = await detectBundledApp(appDir);

  if (!entryFile) {
    return { success: true, errors: [], outputFiles: [], legacy: true };
  }

  const entryPoint = path.join(appDir, entryFile);
  const outdir = path.join(appDir, "dist");
  const stagingDir = path.join(appDir, ".dist-staging");

  await fs.mkdir(outdir, { recursive: true });
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });

  try {
    const esbuild = await import("esbuild");
    const result = await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      outdir: stagingDir,
      entryNames: "app",
      format: "esm",
      platform: "browser",
      target: "es2020",
      sourcemap: "inline",
      metafile: true,
      logLevel: "silent",
      loader: {
        ".ts": "ts",
        ".tsx": "tsx",
        ".css": "css",
      },
      // Emit CSS as a separate file (not inlined into JS)
      // esbuild automatically extracts `import './foo.css'` into dist/app.css
    });

    const stagedOutputs = Object.keys(result.metafile?.outputs ?? {});
    for (const stagedPath of stagedOutputs) {
      const rel = path.relative(stagingDir, stagedPath);
      const dest = path.join(outdir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(stagedPath, dest);
    }
    await fs.rm(stagingDir, { recursive: true, force: true });

    const outputFiles = stagedOutputs.map((p) => path.join(outdir, path.relative(stagingDir, p)));

    const warnings: MiniAppBuildError[] = result.warnings.map((w) =>
      formatEsbuildMessage(w, appDir, "warning"),
    );

    return { success: true, errors: warnings, outputFiles, legacy: false };
  } catch (buildError: unknown) {
    const errors: MiniAppBuildError[] = [];

    if (
      buildError !== null &&
      typeof buildError === "object" &&
      "errors" in buildError &&
      Array.isArray((buildError as { errors: unknown[] }).errors)
    ) {
      const esbuildErrors = (buildError as { errors: Array<{ text: string; location?: { file?: string; line?: number; column?: number } }> }).errors;
      for (const e of esbuildErrors) {
        errors.push(formatEsbuildMessage(e, appDir, "error"));
      }
    } else {
      const { formatEsbuildErrorMessage } = await import(
        "../utils/miniAppTranspile.js"
      );
      errors.push({
        file: entryFile,
        message: formatEsbuildErrorMessage(
          buildError instanceof Error
            ? buildError.message
            : String(buildError),
        ),
        severity: "error",
      });
    }

    if (
      buildError !== null &&
      typeof buildError === "object" &&
      "warnings" in buildError &&
      Array.isArray((buildError as { warnings: unknown[] }).warnings)
    ) {
      const esbuildWarnings = (buildError as { warnings: Array<{ text: string; location?: { file?: string; line?: number; column?: number } }> }).warnings;
      for (const w of esbuildWarnings) {
        errors.push(formatEsbuildMessage(w, appDir, "warning"));
      }
    }

    return { success: false, errors, outputFiles: [], legacy: false };
  }
}

function formatEsbuildMessage(
  msg: { text: string; location?: { file?: string; line?: number; column?: number } | null },
  appDir: string,
  severity: "error" | "warning",
): MiniAppBuildError {
  const file = msg.location?.file
    ? path.relative(appDir, msg.location.file)
    : "build";
  return {
    file,
    line: msg.location?.line,
    column: msg.location?.column,
    message: msg.text,
    severity,
  };
}

/**
 * Check whether a built dist/ is stale relative to source files.
 * Returns true if a rebuild is needed.
 */
export async function isBuildStale(appDir: string): Promise<boolean> {
  const distJs = path.join(appDir, "dist", "app.js");
  let distMtime: number;
  try {
    const stat = await fs.stat(distJs);
    distMtime = stat.mtimeMs;
  } catch {
    return true; // No dist output yet
  }

  const sourceFiles = await collectSourceFiles(appDir);
  for (const file of sourceFiles) {
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs > distMtime) return true;
    } catch {
      // File removed — stale
      return true;
    }
  }
  return false;
}

export interface BundledEntryRewriteOptions {
  /** When true, inject `<link href="dist/app.css">` if not already present. */
  hasDistCss?: boolean;
}

/**
 * Rewrite index.html entry scripts (app.ts / main.ts) to use dist/app.js.
 * Large bundled apps otherwise fetch 50+ transpiled modules per reload; any
 * iframe abort mid-load leaves the static shell visible with empty data.
 */
export function rewriteHtmlForBundledDist(
  html: string,
  options: BundledEntryRewriteOptions = {},
): string {
  let result = html;

  result = result.replace(
    /<script([^>]*)\stype=["']module["']([^>]*)>\s*import\s+['"]\.\/(app|main)(?:\.tsx?)['"]\s*;?\s*<\/script>/gi,
    '<script type="module" src="dist/app.js"></script>',
  );

  result = result.replace(
    /<script([^>]*)\ssrc=["']\.\/(app|main)(?:\.tsx?)["']([^>]*)>/gi,
    '<script$1 src="dist/app.js"$3>',
  );
  result = result.replace(
    /<script([^>]*)\ssrc=["'](app|main)(?:\.tsx?)["']([^>]*)>/gi,
    '<script$1 src="dist/app.js"$3>',
  );

  if (!/rel=["']modulepreload["'][^>]*dist\/app\.js/i.test(result)) {
    result = result.replace(
      /<\/head>/i,
      '  <link rel="modulepreload" href="dist/app.js">\n</head>',
    );
  }

  if (options.hasDistCss && !/dist\/app\.css/i.test(result)) {
    result = result.replace(
      /<\/head>/i,
      '  <link rel="stylesheet" href="dist/app.css">\n</head>',
    );
  }

  return result;
}

/** Append ?v= content hashes so browsers fetch new bundles after sync. */
export function appendDistAssetCacheBusters(
  html: string,
  versions: { appJs?: string; appCss?: string },
): string {
  let result = html;
  if (versions.appJs) {
    result = result.replace(
      /((?:src|href)=["'])(dist\/app\.js)(\?[^"']*)?(["'])/gi,
      `$1$2?v=${versions.appJs}$4`,
    );
  }
  if (versions.appCss) {
    result = result.replace(
      /((?:src|href)=["'])(dist\/app\.css)(\?[^"']*)?(["'])/gi,
      `$1$2?v=${versions.appCss}$4`,
    );
  }
  return result;
}

/** When dist/app.js exists on disk, prefer the bundled entry in index.html. */
export async function preferBundledEntryInHtml(
  html: string,
  appDir: string,
): Promise<string> {
  const distJs = path.join(appDir, "dist", "app.js");
  try {
    await fs.access(distJs);
  } catch {
    return html;
  }

  let hasDistCss = false;
  try {
    await fs.access(path.join(appDir, "dist", "app.css"));
    hasDistCss = true;
  } catch {
    // No extracted CSS bundle
  }

  return rewriteHtmlForBundledDist(html, { hasDistCss });
}

async function collectSourceFiles(
  dir: string,
  files: string[] = [],
): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === ".dist-staging" || entry.name === ".versions" || entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(fullPath, files);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if ([".ts", ".tsx", ".css", ".js", ".jsx"].includes(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}
