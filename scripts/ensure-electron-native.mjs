#!/usr/bin/env node
/**
 * Verify native modules load under Electron's Node ABI.
 * Plain `npm rebuild` compiles for system Node and breaks the Gateway.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronBin =
  process.platform === "win32"
    ? path.join(root, "node_modules/electron/dist/electron.exe")
    : path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      );

if (!existsSync(electronBin)) {
  process.exit(0);
}

const probe = spawnSync(
  electronBin,
  ["-e", "require('better-sqlite3');"],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "pipe",
    encoding: "utf8",
  },
);

if (probe.status === 0) {
  process.exit(0);
}

console.log(
  "[ensure-electron-native] better-sqlite3 ABI mismatch — rebuilding for Electron...",
);
const rebuild = spawnSync(
  "npx",
  ["@electron/rebuild", "-f", "-w", "better-sqlite3"],
  { cwd: root, stdio: "inherit", shell: true },
);

process.exit(rebuild.status ?? 1);
