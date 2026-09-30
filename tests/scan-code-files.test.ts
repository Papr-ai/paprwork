import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { scanCodeFiles } from "../src/gateway/services/storage/scanCodeFiles.js";
test("streams project code, excluding dependencies, loose files and symlink cycles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "papr-scan-"));
  try {
    for (const dir of ["apps/a/node_modules", "Jobs/j", "apps/a/nested"]) await mkdir(path.join(root, dir), { recursive: true });
    for (const file of ["apps/loose.ts", "apps/a/main.ts", "apps/a/node_modules/dep.js", "apps/a/nested/code.py", "Jobs/j/job.js"]) await writeFile(path.join(root, file), "code");
    await symlink(path.join(root, "apps/a"), path.join(root, "apps/a/loop"), "dir");
    const files: string[] = [];
    for await (const file of scanCodeFiles(root)) files.push(path.relative(root, file));
    expect(files.sort()).toEqual(["Jobs/j/job.js", "apps/a/main.ts", "apps/a/nested/code.py"]);
    const controller = new AbortController(); controller.abort();
    await expect(scanCodeFiles(root, controller.signal).next()).rejects.toBeDefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
