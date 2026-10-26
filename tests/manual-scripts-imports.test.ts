import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// tests/manual/* are run by hand (npm run test:new-models, tsx …) and are
// excluded from vitest, so a broken relative import there goes unnoticed
// until someone runs the script (#508). Check every relative import resolves.
const dir = path.join(__dirname, "manual");
const exts = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", "/index.ts"];

describe("tests/manual scripts", () => {
  for (const file of readdirSync(dir).filter((f) => /\.(ts|mjs|js)$/.test(f))) {
    it(`${file}: relative imports resolve`, () => {
      const src = readFileSync(path.join(dir, file), "utf8");
      const specs = [...src.matchAll(/(?:from|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]);
      const missing = specs.filter((s) => {
        const base = path.resolve(dir, s.replace(/\.js$/, ""));
        return !exts.some((e) => existsSync(base + e)) && !existsSync(path.resolve(dir, s));
      });
      expect(missing).toEqual([]);
    });
  }
});
