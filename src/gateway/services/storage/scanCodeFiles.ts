import { opendir } from "node:fs/promises";
import path from "node:path";

const excluded = new Set(["node_modules", ".venv", "venv", ".git", "dist",
  "build", "data", "__pycache__", ".next", ".nuxt", "papr_repo"]);
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);

/** Stream directory entries with async OS I/O; never follow symlinks/cycles. */
export async function* scanCodeFiles(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  async function* walk(dir: string, projectsOnly = false): AsyncGenerator<string> {
    signal?.throwIfAborted();
    let entries;
    try { entries = await opendir(dir); }
    catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    for await (const entry of entries) {
      signal?.throwIfAborted();
      if (excluded.has(entry.name) || entry.name.includes("_repo")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (!projectsOnly && entry.isFile() && extensions.has(path.extname(entry.name))) yield full;
    }
  }
  for (const container of ["apps", "Jobs"]) yield* walk(path.join(root, container), true);
}
