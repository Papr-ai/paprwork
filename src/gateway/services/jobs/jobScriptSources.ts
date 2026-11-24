/**
 * Read a job's own script files so architecture rules can check the code, not just the
 * command line (`python3 code/sync.py` says nothing about what sync.py writes).
 */
import { promises as fs } from "fs";
import path from "path";

const SCRIPT_EXT = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".sql"]);
const MAX_FILES = 40;
const MAX_TOTAL_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__", "data", "logs", ".git"]);

export async function readJobScriptSources(jobDir: string): Promise<string> {
  const parts: string[] = [];
  let total = 0;
  let files = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || files >= MAX_FILES || total >= MAX_TOTAL_BYTES) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files >= MAX_FILES || total >= MAX_TOTAL_BYTES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(full, depth + 1);
      } else if (SCRIPT_EXT.has(path.extname(entry.name).toLowerCase())) {
        try {
          const text = await fs.readFile(full, "utf8");
          const slice = text.slice(0, MAX_TOTAL_BYTES - total);
          parts.push(slice);
          total += slice.length;
          files += 1;
        } catch {
          // unreadable file: skip
        }
      }
    }
  };
  await walk(jobDir, 0);
  return parts.join("\n");
}
