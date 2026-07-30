/**
 * Replace old UUIDs with new ones in app/job source files (fork install, bundle import).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

const REMAPPABLE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".css",
  ".py",
  ".sh",
  ".swift",
  ".md",
]);

const SKIP_FILENAMES = new Set(["papr-cloud-lineage.json"]);

export interface ApplyIdRemapsResult {
  remappedFiles: string[];
}

export async function applyIdRemapsToDirectory(
  dir: string,
  remaps: Map<string, string>,
): Promise<ApplyIdRemapsResult> {
  if (remaps.size === 0) {
    return { remappedFiles: [] };
  }

  const remappedFiles: string[] = [];

  async function walkAndRemap(currentDir: string, baseDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (SKIP_FILENAMES.has(entry.name)) continue;

      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walkAndRemap(full, baseDir);
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!REMAPPABLE_EXTENSIONS.has(ext)) continue;

      try {
        let content = await fs.readFile(full, "utf8");
        let changed = false;
        for (const [oldId, newId] of remaps) {
          if (oldId === newId) continue;
          if (content.includes(oldId)) {
            content = content.split(oldId).join(newId);
            changed = true;
          }
        }
        if (changed) {
          await fs.writeFile(full, content, "utf8");
          remappedFiles.push(path.relative(baseDir, full).replace(/\\/g, "/"));
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  await walkAndRemap(dir, dir);
  return { remappedFiles };
}
