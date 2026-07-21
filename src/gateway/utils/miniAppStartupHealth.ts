/**
 * Mini-app startup health checks (warning-level, never block).
 *
 * Motivated by a real debugging session where an app eagerly imported
 * 88 TS modules (~336KB) at startup and rendered as a blank iframe with
 * no diagnostics. These checks surface that class of problem at
 * validate_app time instead of at runtime.
 */

export interface StartupHealthIssue {
  file: string;
  line?: number;
  severity: "warning" | "error";
  message: string;
  rule: string;
}

const MAX_STARTUP_MODULES = 40;
const MAX_STARTUP_BYTES = 150 * 1024;
const MAX_INITIAL_STYLESHEETS = 15;
const MAX_SINGLE_MODULE_BYTES = 200 * 1024;

/** Resolve a relative import specifier against the importing file's dir. */
function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const fromDir = fromFile.includes("/")
    ? fromFile.slice(0, fromFile.lastIndexOf("/"))
    : "";
  const parts = (fromDir ? fromDir + "/" + spec : spec).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function candidateKeys(resolved: string): string[] {
  if (/\.(ts|tsx|js|jsx)$/.test(resolved)) return [resolved];
  return [
    `${resolved}.ts`,
    `${resolved}.tsx`,
    `${resolved}.js`,
    `${resolved}.jsx`,
    `${resolved}/index.ts`,
    `${resolved}/index.js`,
  ];
}

/** Static (eager) import specifiers only — dynamic import() is the fix, not the problem. */
function staticImportSpecs(source: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:^|\n)\s*(?:import\s+[^'"]*?from\s*|import\s*|export\s+[^'"]*?from\s*)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    specs.push(m[1]);
  }
  return specs;
}

/** Walk the eager import graph from the entry module. */
function walkStartupGraph(
  entry: string,
  files: Map<string, string>,
): { modules: string[]; bytes: number } {
  const visited = new Set<string>();
  const queue = [entry];
  let bytes = 0;
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    const content = files.get(current);
    if (content === undefined) continue;
    visited.add(current);
    bytes += Buffer.byteLength(content, "utf-8");
    for (const spec of staticImportSpecs(content)) {
      const resolved = resolveImport(current, spec);
      if (!resolved) continue;
      for (const key of candidateKeys(resolved)) {
        if (files.has(key) && !visited.has(key)) {
          queue.push(key);
          break;
        }
      }
    }
  }
  return { modules: Array.from(visited), bytes };
}

function findEntryModule(indexHtml: string): string | null {
  const m = indexHtml.match(
    /<script[^>]*type=["']module["'][^>]*src=["']\.?\/?([^"']+)["']/i,
  );
  return m ? m[1] : null;
}

export function checkMiniAppStartupHealth(
  files: Map<string, string>,
): StartupHealthIssue[] {
  const issues: StartupHealthIssue[] = [];
  const indexHtml = files.get("index.html");
  if (!indexHtml) return issues;

  // 1. Startup import graph weight
  const entry = findEntryModule(indexHtml);
  if (entry && files.has(entry)) {
    const { modules, bytes } = walkStartupGraph(entry, files);
    if (modules.length > MAX_STARTUP_MODULES || bytes > MAX_STARTUP_BYTES) {
      issues.push({
        file: entry,
        severity: "warning",
        message:
          `Startup import graph is heavy: ${modules.length} modules / ${Math.round(bytes / 1024)}KB loaded eagerly before first paint. ` +
          `The embedded iframe can stall on heavy startup graphs (blank app shell). ` +
          `Lazy-load non-initial views with dynamic import() — keep startup under ~${MAX_STARTUP_MODULES} modules / ${Math.round(MAX_STARTUP_BYTES / 1024)}KB.`,
        rule: "startup-weight",
      });
    }
    for (const mod of modules) {
      const content = files.get(mod);
      if (content && Buffer.byteLength(content, "utf-8") > MAX_SINGLE_MODULE_BYTES) {
        issues.push({
          file: mod,
          severity: "warning",
          message:
            `Module is ${Math.round(Buffer.byteLength(content, "utf-8") / 1024)}KB and imported eagerly at startup ` +
            `(often a base64 asset). Move it behind a dynamic import() in the view that uses it.`,
          rule: "startup-weight",
        });
      }
    }
  }

  // 2. Render-blocking stylesheet count
  const cssLinks = indexHtml.match(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi) ?? [];
  if (cssLinks.length > MAX_INITIAL_STYLESHEETS) {
    issues.push({
      file: "index.html",
      severity: "warning",
      message:
        `${cssLinks.length} render-blocking stylesheets in index.html. ` +
        `Keep initial CSS under ~${MAX_INITIAL_STYLESHEETS} files and lazy-load per-view styles.`,
      rule: "startup-weight",
    });
  }

  // 3. Selector drift: IDs referenced in scripts that don't exist in the HTML
  const htmlIds = new Set<string>();
  const idRe = /\bid=["']([^"']+)["']/g;
  let idMatch: RegExpExecArray | null;
  while ((idMatch = idRe.exec(indexHtml)) !== null) htmlIds.add(idMatch[1]);

  // Collect IDs created dynamically anywhere in scripts (innerHTML, template
  // strings, createElement + id assignment) so we only flag true misses.
  const dynamicIds = new Set<string>();
  for (const [name, content] of files) {
    if (!/\.(ts|tsx|js|jsx)$/.test(name)) continue;
    let dm: RegExpExecArray | null;
    const dynRe = /\bid=\\?["']([^"'\\$]+)\\?["']|\.id\s*=\s*["']([^"']+)["']/g;
    while ((dm = dynRe.exec(content)) !== null) {
      dynamicIds.add(dm[1] ?? dm[2]);
    }
  }

  for (const [name, content] of files) {
    if (!/\.(ts|tsx|js|jsx)$/.test(name)) continue;
    const refRe =
      /getElementById\(\s*["']([^"']+)["']\s*\)|querySelector\(\s*["']#([A-Za-z][\w-]*)["']\s*\)/g;
    let rm: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((rm = refRe.exec(content)) !== null) {
      const id = rm[1] ?? rm[2];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (!htmlIds.has(id) && !dynamicIds.has(id)) {
        const line = content.slice(0, rm.index).split("\n").length;
        issues.push({
          file: name,
          line,
          severity: "warning",
          message:
            `Selector "#${id}" is referenced here but no element with that id exists in index.html ` +
            `or is created dynamically. Possible selector drift (renamed id?).`,
          rule: "selector-drift",
        });
      }
    }
  }

  return issues;
}

/**
 * Stale-bundle check: index.html references dist/ output while source files
 * are newer than the bundle. mtimes must be provided by the caller since
 * validation works on in-memory content.
 */
export function checkStaleBundle(
  indexHtml: string | undefined,
  distMtimeMs: number | null,
  newestSourceMtimeMs: number | null,
): StartupHealthIssue[] {
  if (!indexHtml || !/src=["'][^"']*dist\/[^"']+["']/.test(indexHtml)) return [];
  if (distMtimeMs === null) {
    return [
      {
        file: "index.html",
        severity: "error",
        message:
          "index.html references dist/ output but no dist bundle exists. Build the app or switch to source mode (script src pointing at the .ts entry).",
        rule: "stale-bundle",
      },
    ];
  }
  if (newestSourceMtimeMs !== null && newestSourceMtimeMs > distMtimeMs) {
    return [
      {
        file: "index.html",
        severity: "error",
        message:
          "Source files are newer than the dist/ bundle referenced by index.html — the iframe is serving stale code while your edits may not compile. Run validate_app({ appId }) to rebuild before previewing.",
        rule: "stale-bundle",
      },
    ];
  }
  return [];
}
