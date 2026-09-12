/**
 * Canonical Papr workspace root.
 *
 * Desktop: ~/Papr/orgs/{orgId}/namespaces/{namespaceId} (via .active-workspace.json)
 * Legacy fallback: ~/Papr
 * Cloud agent gateway: per-run clone mounted at PAPR_HOME
 */

import fs from "fs";
import os from "os";
import path from "path";
import {
  ensureActiveWorkspaceEnvSynced,
  getPaprBaseDir,
} from "./paprWorkspace.js";

function formatPathForAgent(absolutePath: string): string {
  const home = os.homedir();
  const resolved = path.resolve(absolutePath);
  const prefix = `${home}${path.sep}`;
  if (resolved.startsWith(prefix)) {
    return `~${path.sep}${path.relative(home, resolved)}`;
  }
  return resolved;
}

export function getPaprRoot(): string {
  const override = process.env.PAPR_HOME?.trim();
  const pointer = ensureActiveWorkspaceEnvSynced();

  // Cloud agent runs use ephemeral PAPR_HOME clones — no desktop pointer file.
  if (isCloudAgentGatewayMode() || !pointer?.paprHome) {
    if (override) {
      return assertNotLeakingIntoRealWorkspace(path.resolve(override));
    }
    return assertNotLeakingIntoRealWorkspace(getPaprBaseDir());
  }

  return assertNotLeakingIntoRealWorkspace(path.resolve(pointer.paprHome));
}

/**
 * Under vitest, a workspace root outside the OS temp dir means a test is about
 * to write into the developer's REAL workspace. On 2026-08-12 this silently
 * created ~305 fixture apps and 462 job folders in a live workspace because
 * suites patched only `os.homedir`, while getPaprRoot() prefers the
 * .active-workspace.json pointer read from the real home.
 *
 * Fail loudly instead. Tests must use tests/setup/isolatedWorkspace.ts.
 */
function assertNotLeakingIntoRealWorkspace(resolvedRoot: string): string {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    return resolvedRoot;
  }
  if (process.env.PAPR_ALLOW_REAL_WORKSPACE_IN_TESTS === "1") {
    return resolvedRoot;
  }

  const tmpRoot = path.resolve(fs.realpathSync.native(os.tmpdir()));
  const candidate = realpathThroughMissingLeaves(path.resolve(resolvedRoot));

  if (candidate === tmpRoot || candidate.startsWith(`${tmpRoot}${path.sep}`)) {
    return resolvedRoot;
  }

  throw new Error(
    `[paprRoot] Refusing to use a real Papr workspace during tests: ${candidate}\n` +
      `Tests must not write to the developer's live workspace.\n` +
      `Fix: import { useIsolatedPaprWorkspace } from "../tests/setup/isolatedWorkspace.js" ` +
      `and call it in your describe block.\n` +
      `Patching os.homedir alone is NOT enough — getPaprRoot() prefers ` +
      `~/Papr/.active-workspace.json and re-syncs PAPR_HOME from it.\n` +
      `Escape hatch (only for tests that intentionally read the real workspace): ` +
      `PAPR_ALLOW_REAL_WORKSPACE_IN_TESTS=1`,
  );
}

/**
 * Resolve symlinks as far down `absolutePath` as actually exists on disk.
 *
 * The comparison above needs both sides in the same form, and `tmpRoot` is
 * always realpath-resolved. A workspace path is routinely named *before* it is
 * created, though, so `realpathSync` on the whole thing throws — and falling
 * back to the literal path compares macOS's `/var/folders/...` against the
 * resolved `/private/var/folders/...` and never matches. That rejected suites
 * which were using a temp directory perfectly correctly, purely because their
 * leaf directory did not exist yet.
 *
 * So resolve the deepest ancestor that does exist and re-attach the rest. This
 * does not weaken the guard: a real workspace resolves through the real home
 * and still lands outside the temp root.
 */
function realpathThroughMissingLeaves(absolutePath: string): string {
  const missing: string[] = [];
  let current = absolutePath;

  for (;;) {
    try {
      const resolved = fs.realpathSync.native(current);
      return missing.length > 0
        ? path.join(resolved, ...missing.reverse())
        : resolved;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding anything that exists.
        return absolutePath;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function getPaprJobsRoot(): string {
  return path.join(getPaprRoot(), "Jobs");
}

export function getPaprAppsRoot(): string {
  return path.join(getPaprRoot(), "apps");
}

/**
 * Block direct write_file edits to mini-app trees — agents must use
 * edit_app_file / edit_app_file_lines so esbuild + validation run immediately.
 */
export function getMiniAppWriteBlockReason(resolvedFilePath: string): string | null {
  const appsRoot = path.resolve(getPaprAppsRoot());
  const resolved = path.resolve(resolvedFilePath);
  const prefix = `${appsRoot}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    return null;
  }

  const rel = path.relative(appsRoot, resolved);
  const segments = rel.split(path.sep);
  if (segments.length < 2 || !segments[0]) {
    return null;
  }

  const appId = segments[0];
  const filename = segments.slice(1).join("/");

  if (/^dist[/\\]/.test(filename)) {
    return (
      `⛔ dist/ is auto-generated by esbuild — do not edit. ` +
      `Fix source files, then validate_app({ appId: "${appId}" }).`
    );
  }

  return (
    `⛔ Use write_file or edit_file for mini-app sources (auto-runs esbuild + validation). ` +
    `Active path: ${formatPathForAgent(path.join(appsRoot, appId, filename))} ` +
    `or write_file({ path: "${formatPathForAgent(path.join(appsRoot, appId, filename))}", content: "..." }).`
  );
}

export function getPaprDataDir(): string {
  return path.join(getPaprRoot(), "data");
}

export function getPaprWorkspaceDir(): string {
  return path.join(getPaprRoot(), "workspace");
}

export function getPaprDocumentsDir(): string {
  return path.join(getPaprRoot(), "documents");
}

export function getPaprBundlesDir(): string {
  return path.join(getPaprRoot(), "bundles");
}

/** Shared Cloud Run agent gateway — no desktop CloudSync / scheduler. */
export function isCloudAgentGatewayMode(): boolean {
  return process.env.GATEWAY_MODE === "cloud_agent";
}
