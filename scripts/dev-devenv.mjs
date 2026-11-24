#!/usr/bin/env node
/**
 * npm run dev:devenv — "Papr Work Dev" against the development backend,
 * side by side with a running production Papr Work.
 *
 * - Own ports: gateway 18799, UI 5174 (prod uses 18789 / 5173).
 * - Clears inherited Papr env: a terminal opened from Papr Work (or Pen's
 *   shell) carries ELECTRON_RUN_AS_NODE=1, PAPR_HOME, PAPR_API_KEY and the
 *   prod PAPR_APP_REPO_WRITER_URL. dotenv never overrides set variables, so
 *   those would win over .env.development and point the dev app at prod.
 * - Builds gateway + electron (the main process imports dist/electron/*).
 * - Clears a stale "Papr Work Dev" single-instance lock left by a crashed
 *   start, so the next launch does not quit with "Another instance".
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const GATEWAY_PORT = process.env.PAPR_DEV_GATEWAY_PORT || "18799";
const UI_PORT = process.env.PAPR_DEV_UI_PORT || "5174";

if (!existsSync(".env.development")) {
  console.error("Missing .env.development — copy .env.development.example first.");
  process.exit(1);
}

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key === "ELECTRON_RUN_AS_NODE" || /^(PAPR_|PARSE_|AUTH0_)/.test(key)) delete env[key];
}
Object.assign(env, {
  PAPR_PROFILE: "dev",
  GATEWAY_PORT,
  VITE_GATEWAY_PORT: GATEWAY_PORT,
  VITE_PORT: UI_PORT,
  UI_DEV_URL: `http://localhost:${UI_PORT}`,
  VITE_REQUIRE_PAPR_AUTH: "true",
  NODE_ENV: "development",
});

function portInUse(port) {
  return spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim() !== "";
}
for (const port of [GATEWAY_PORT, UI_PORT]) {
  if (portInUse(port)) {
    console.error(`Port ${port} is busy — is Papr Work Dev already running?`);
    process.exit(1);
  }
}

if (process.platform === "darwin") {
  const userData = path.join(os.homedir(), "Library", "Application Support", "Papr Work Dev");
  const lock = path.join(userData, "SingletonLock");
  try {
    const pid = Number(readlinkSync(lock).split("-").pop());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (!alive) {
      for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        rmSync(path.join(userData, f), { force: true });
      }
      console.log(`Cleared stale Papr Work Dev lock (pid ${pid} not running)`);
    }
  } catch {}
}

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("npm", ["run", "build:gateway"]);
run("npm", ["run", "build:electron"]);

const child = spawn(
  "npx",
  ["concurrently", "-k", "-n", "ui,electron", "npm run ui:dev", "node scripts/patch-electron-dev-plist.mjs && electron ."],
  { stdio: "inherit", env, shell: process.platform === "win32" },
);
child.on("exit", (code) => process.exit(code ?? 0));
