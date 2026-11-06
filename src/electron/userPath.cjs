"use strict";
/**
 * Repair PATH for GUI launches.
 *
 * Electron started from Finder/Dock inherits launchd's PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so Homebrew tools (rg, gh, ...) are invisible
 * to the gateway and everything it spawns: search_files then silently falls back to
 * the slow walk engine. Two layers:
 *   1. ensureUserPath()        sync + instant: append well-known dirs that exist.
 *   2. mergeLoginShellPath()   async: read the user's real PATH from a NON-interactive
 *      login shell (loads ~/.zprofile where `brew shellenv` lives, no .zshrc prompts).
 *      It can take 1-2s, so it never blocks startup.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const MARK = "__PAPR_PATH__";
const SHELLS = new Set(["zsh", "bash", "sh"]);

function fallbackDirs(platform, home) {
  const j = (...p) => path.join(home, ...p);
  if (platform === "darwin") {
    return ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin", j(".local", "bin"), j(".cargo", "bin")];
  }
  if (platform === "linux") {
    return ["/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", j(".local", "bin"), j(".cargo", "bin")];
  }
  return [];
}

/** Join entries in order, dropping empties and duplicates. */
function mergePath(first, rest, delimiter = ":") {
  const seen = new Set();
  const out = [];
  for (const p of [...String(first || "").split(delimiter), ...rest]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out.join(delimiter);
}

/** Pull PATH out of shell output that may contain rc-file noise. */
function parseShellPath(stdout) {
  const m = new RegExp(`${MARK}(.*?)${MARK}`, "s").exec(String(stdout || ""));
  return m && m[1].trim() ? m[1].trim() : null;
}

function ensureUserPath(opts = {}) {
  const { platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync } = opts;
  if (platform === "win32") return env.PATH;
  const dirs = fallbackDirs(platform, home).filter((d) => exists(d));
  env.PATH = mergePath(env.PATH, dirs);
  return env.PATH;
}

function mergeLoginShellPath(opts = {}) {
  const { platform = process.platform, env = process.env, run = execFile, timeoutMs = 5000 } = opts;
  const shell = env.SHELL;
  if (platform === "win32" || !shell || !SHELLS.has(path.basename(shell))) return Promise.resolve(null);
  return new Promise((resolve) => {
    run(shell, ["-lc", `printf '%s' "${MARK}$PATH${MARK}"`], { timeout: timeoutMs, env }, (err, stdout) => {
      const shellPath = err ? null : parseShellPath(stdout);
      if (shellPath) env.PATH = mergePath(shellPath, String(env.PATH || "").split(":"));
      resolve(shellPath ? env.PATH : null);
    });
  });
}

module.exports = { ensureUserPath, mergeLoginShellPath, mergePath, parseShellPath, fallbackDirs };
