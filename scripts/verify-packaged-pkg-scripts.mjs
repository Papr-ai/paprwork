#!/usr/bin/env node
// Fails if any release/*.pkg is missing the postinstall script (auto-launch after install).
// Guards against electron-builder silently skipping a mis-resolved `pkg.scripts` path.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const releaseDir = process.argv[2] || "release";
const pkgs = readdirSync(releaseDir).filter((f) => f.endsWith(".pkg"));
if (pkgs.length === 0) {
  console.error(`[verify-pkg-scripts] No .pkg files in ${releaseDir}`);
  process.exit(1);
}

let failed = false;
for (const name of pkgs) {
  const work = mkdtempSync(join(tmpdir(), "pkgx-"));
  const out = join(work, "x");
  try {
    execFileSync("pkgutil", ["--expand", join(releaseDir, name), out]);
    const comp = readdirSync(out).find((f) => f.endsWith(".pkg"));
    const compDir = comp ? join(out, comp) : out;
    const hasScript = existsSync(join(compDir, "Scripts", "postinstall"));
    const info = readFileSync(join(compDir, "PackageInfo"), "utf8");
    const declared = /<postinstall\b/.test(info) || /<scripts>/.test(info);
    if (!hasScript || !declared) {
      console.error(`[verify-pkg-scripts] ${name}: postinstall MISSING (script=${hasScript}, declared=${declared})`);
      failed = true;
    } else {
      console.log(`[verify-pkg-scripts] ${name}: postinstall present`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
