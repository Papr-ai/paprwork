/**
 * Local Python modules a cloud backend handler imports.
 *
 * On the desktop a handler runs in place (backend/overview.py), so `from caller import x`
 * finds backend/lib/caller.py through the handler's own sys.path line, and
 * `from add_source import y` finds the sibling backend/add_source.py. The cloud runner
 * writes the handler into an empty temp dir as handler.py, so those imports failed with
 * ModuleNotFoundError. This resolves them from the app repo so the runner can lay them
 * out next to handler.py the same way (backend/X.py -> X.py, backend/lib/X.py -> lib/X.py).
 */

/** Names never worth a repo fetch: stdlib + the helper the runner always provides. */
const SKIP = new Set([
  "papr_db", "__future__", "abc", "argparse", "array", "ast", "asyncio", "base64", "binascii",
  "bisect", "calendar", "codecs", "collections", "concurrent", "contextlib", "copy", "csv",
  "ctypes", "dataclasses", "datetime", "decimal", "difflib", "email", "enum", "errno",
  "fnmatch", "fractions", "functools", "gc", "glob", "gzip", "hashlib", "heapq", "hmac",
  "html", "http", "importlib", "inspect", "io", "ipaddress", "itertools", "json", "locale",
  "logging", "math", "mimetypes", "operator", "os", "pathlib", "pickle", "platform", "pprint",
  "queue", "random", "re", "secrets", "select", "shlex", "shutil", "signal", "socket",
  "sqlite3", "ssl", "statistics", "string", "struct", "subprocess", "sys", "tempfile",
  "textwrap", "threading", "time", "timeit", "traceback", "types", "typing", "unicodedata",
  "urllib", "uuid", "warnings", "weakref", "xml", "zipfile", "zlib", "zoneinfo",
]);

const MAX_MODULES = 24;
const MAX_DEPTH = 4;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LIB_NAME = /^lib\.[A-Za-z_][A-Za-z0-9_]*$/;

/** Top-level module names a Python source imports (absolute imports only). */
export function pythonImportNames(source: string): string[] {
  const names = new Set<string>();
  for (const raw of source.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const from = /^from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(line);
    if (from) {
      names.add(moduleKey(from[1]));
      continue;
    }
    const imp = /^import\s+(.+)$/.exec(line);
    if (imp) {
      for (const part of imp[1].split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (name) names.add(moduleKey(name));
      }
    }
  }
  return [...names].filter((n) => (NAME.test(n) || LIB_NAME.test(n)) && !SKIP.has(n));
}

/**
 * Top-level name, except `lib.X` stays dotted: `from lib.common import y` needs
 * backend/lib/common.py, which a bare "lib" lookup (backend/lib.py) never finds.
 */
function moduleKey(dotted: string): string {
  const [top, sub] = dotted.split(".");
  return top === "lib" && sub ? `lib.${sub}` : top;
}

/** Only flat X.py or lib/X.py — never anything that could leave the temp dir. */
export function isSafeBackendModulePath(rel: string): boolean {
  return /^(lib\/)?[A-Za-z_][A-Za-z0-9_]*\.py$/.test(rel);
}

/**
 * Walk the handler's imports and fetch matching backend/X.py or backend/lib/X.py.
 * Returns { "X.py" | "lib/X.py": source } relative to the handler's directory.
 * fetchFile returns null when the repo has no such file (stdlib / third-party names).
 */
export async function resolveBackendPythonModules(
  handlerSource: string,
  fetchFile: (repoPath: string) => Promise<string | null>,
  handlerFile?: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const seen = new Set<string>(handlerFile ? [handlerFile.replace(/\.py$/, "")] : []);
  let frontier: Array<{ source: string; depth: number }> = [{ source: handlerSource, depth: 0 }];

  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { source, depth } of frontier) {
      if (depth >= MAX_DEPTH) continue;
      for (const name of pythonImportNames(source)) {
        if (seen.has(name) || Object.keys(out).length >= MAX_MODULES) continue;
        seen.add(name);
        const candidates = name.startsWith("lib.") ? [`lib/${name.slice(4)}.py`] : [`${name}.py`, `lib/${name}.py`];
        for (const rel of candidates) {
          const content = await fetchFile(`backend/${rel}`);
          if (content === null) continue;
          out[rel] = content;
          next.push({ source: content, depth: depth + 1 });
          break;
        }
      }
    }
    frontier = next;
  }
  return out;
}
