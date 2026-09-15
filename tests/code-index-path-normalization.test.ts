import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { normalizeIndexPath } from "../src/gateway/services/storage/codeIndexPaths.js";

/**
 * Regression guard for the code-index duplication defect.
 *
 * The indexer keyed `indexed_files` / `file_summaries` on the RAW path string,
 * so one file on disk could be indexed under several spellings and each copy
 * paid for its own enrichment. A real workspace accumulated 193 of 534 files
 * stored under two spellings (~/Papr/... and ~/PAPR/...).
 */
describe("normalizeIndexPath", () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-index-norm-"));
    file = path.join(dir, "app.ts");
    fs.writeFileSync(file, "export const x = 1;\n");
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("is idempotent", () => {
    expect(normalizeIndexPath(normalizeIndexPath(file))).toBe(normalizeIndexPath(file));
  });

  test("collapses redundant separators and dot segments", () => {
    const canonical = normalizeIndexPath(file);
    const messy = path.join(dir, ".", "app.ts").replace(`${path.sep}`, `${path.sep}${path.sep}`);
    expect(normalizeIndexPath(messy)).toBe(canonical);
  });

  test("resolves symlinks to the real file, so one inode has one identity", () => {
    const link = path.join(dir, "linked.ts");
    try {
      fs.symlinkSync(file, link);
    } catch {
      return; // symlink perms unavailable — skip rather than fail
    }
    expect(normalizeIndexPath(link)).toBe(normalizeIndexPath(file));
  });

  test("collapses case-variant spellings on case-INSENSITIVE filesystems", () => {
    const upper = path.join(dir.toUpperCase(), "app.ts");
    // Only meaningful where the OS actually resolves the upper-cased dir.
    if (!fs.existsSync(upper)) return;
    expect(normalizeIndexPath(upper)).toBe(normalizeIndexPath(file));
  });

  test("returns an absolute path for files that do not exist", () => {
    const missing = path.join(dir, "deleted.ts");
    expect(path.isAbsolute(normalizeIndexPath(missing))).toBe(true);
  });

  test("passes empty input through without throwing", () => {
    expect(normalizeIndexPath("")).toBe("");
  });
});
