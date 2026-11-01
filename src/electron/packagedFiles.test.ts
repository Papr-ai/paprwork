/**
 * Every ./*.cjs file the packaged Electron main process requires must be listed in
 * electron-builder.json "files", or the shipped app throws "Cannot find module" at runtime
 * (#452 added webviewSessionCap.cjs but not to the list, which broke mini-app previews).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const files: string[] = JSON.parse(readFileSync(path.join(root, "electron-builder.json"), "utf8")).files;

function isPackaged(rel: string): boolean {
  return files.some((pattern) => {
    if (pattern === rel) return true;
    const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*/g, "[^/]*") + "$");
    return re.test(rel);
  });
}

function requiredCjs(rel: string, seen = new Set<string>()): Set<string> {
  if (seen.has(rel)) return seen;
  seen.add(rel);
  const src = readFileSync(path.join(root, rel), "utf8");
  for (const m of src.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+\.cjs)["']\s*\)/g)) {
    const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
    if (existsSync(path.join(root, dep))) requiredCjs(dep, seen);
  }
  return seen;
}

describe("packaged Electron files", () => {
  it("includes every .cjs the main process requires", () => {
    const missing = [...requiredCjs("src/electron/main.cjs")].filter((f) => !isPackaged(f));
    expect(missing).toEqual([]);
  });
});
