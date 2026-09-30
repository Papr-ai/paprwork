/**
 * Resolve agent-facing Papr paths to the active org/namespace workspace.
 *
 * Agents are trained on shorthand ~/Papr/apps/ and ~/Papr/Jobs/, but desktop
 * workspaces live under ~/Papr/orgs/{orgId}/namespaces/{nsId}/. Rewriting
 * legacy flat paths prevents orphan files and routes edit_file to mini-app tools.
 */

import os from "os";
import path from "path";
import {
  getPaprBaseDir,
  readActiveWorkspacePointer,
} from "./paprWorkspace.js";
import { getPaprAppsRoot, getPaprDataDir, getPaprJobsRoot, getPaprRoot } from "./paprRoot.js";

export { parseMiniAppIdFromAgentPath } from "./parseMiniAppIdFromPath.js";

export interface PaprWorkspacePathsForAgent {
  paprHome: string;
  appsRoot: string;
  jobsRoot: string;
  dataDir: string;
  workspaceDir: string;
  organizationId?: string;
  namespaceId?: string;
  /** True when active workspace is org/namespace (legacy ~/Papr/apps is NOT canonical). */
  usesOrgNamespaceLayout: boolean;
}

/** Expand a leading `~` to the user's home directory. */
export function expandTildePath(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/** Human-readable path for agent messages (~ prefix when under home). */
export function formatPaprPathForAgent(absolutePath: string): string {
  const home = os.homedir();
  const resolved = path.resolve(absolutePath);
  if (resolved === home) {
    return "~";
  }
  const prefix = `${home}${path.sep}`;
  if (resolved.startsWith(prefix)) {
    return `~${path.sep}${path.relative(home, resolved)}`;
  }
  return resolved;
}

export function getPaprWorkspacePathsForAgent(): PaprWorkspacePathsForAgent {
  const pointer = readActiveWorkspacePointer();
  const paprHome = getPaprRoot();
  const legacyBase = path.resolve(getPaprBaseDir());
  return {
    paprHome,
    appsRoot: getPaprAppsRoot(),
    jobsRoot: getPaprJobsRoot(),
    dataDir: getPaprDataDir(),
    workspaceDir: path.join(paprHome, "workspace"),
    organizationId: pointer?.organizationId,
    namespaceId: pointer?.namespaceId,
    usesOrgNamespaceLayout: path.resolve(paprHome) !== legacyBase,
  };
}

const LEGACY_SUBDIRS = [
  "apps",
  "Jobs",
  "jobs",
  "data",
  "workspace",
  "documents",
  "bundles",
] as const;

/**
 * Rewrite legacy flat ~/Papr/{apps,Jobs,...} paths to the active workspace when
 * org/namespace layout is in use.
 */
export function resolvePaprAgentPath(rawPath: string): string {
  const resolved = path.resolve(expandTildePath(rawPath));
  const pointer = readActiveWorkspacePointer();
  if (!pointer?.paprHome) {
    return resolved;
  }

  const legacyBase = path.resolve(getPaprBaseDir());
  const activeRoot = path.resolve(pointer.paprHome);
  if (activeRoot === legacyBase) {
    return resolved;
  }

  for (const subdir of LEGACY_SUBDIRS) {
    const legacyRoot = path.join(legacyBase, subdir);
    const legacyPrefix = `${legacyRoot}${path.sep}`;
    if (resolved !== legacyRoot && !resolved.startsWith(legacyPrefix)) {
      continue;
    }

    const canonicalSubdir = subdir === "jobs" ? "Jobs" : subdir;
    const activeRootForSub = path.join(activeRoot, canonicalSubdir);
    if (resolved === legacyRoot) {
      return activeRootForSub;
    }
    const suffix = path.relative(legacyRoot, resolved);
    return path.join(activeRootForSub, suffix);
  }

  return resolved;
}

/**
 * Block writes to legacy flat ~/Papr/apps or ~/Papr/Jobs when the active
 * workspace is org/namespace — those paths create orphan files.
 */
export function getLegacyPaprMisrouteBlockReason(
  resolvedFilePath: string,
): string | null {
  const pointer = readActiveWorkspacePointer();
  if (!pointer?.paprHome) {
    return null;
  }

  const legacyBase = path.resolve(getPaprBaseDir());
  const activeRoot = path.resolve(pointer.paprHome);
  if (activeRoot === legacyBase) {
    return null;
  }

  const resolved = path.resolve(resolvedFilePath);
  const activeApps = path.join(activeRoot, "apps");
  const activeJobs = path.join(activeRoot, "Jobs");

  const legacyTargets: Array<{
    legacyRoot: string;
    activeRoot: string;
    kind: "mini-app" | "job";
  }> = [
    { legacyRoot: path.join(legacyBase, "apps"), activeRoot: activeApps, kind: "mini-app" },
    { legacyRoot: path.join(legacyBase, "Jobs"), activeRoot: activeJobs, kind: "job" },
    { legacyRoot: path.join(legacyBase, "jobs"), activeRoot: activeJobs, kind: "job" },
  ];

  for (const target of legacyTargets) {
    const legacyPrefix = `${target.legacyRoot}${path.sep}`;
    if (resolved !== target.legacyRoot && !resolved.startsWith(legacyPrefix)) {
      continue;
    }
    if (resolved.startsWith(`${target.activeRoot}${path.sep}`) || resolved === target.activeRoot) {
      continue;
    }

    const rel = path.relative(target.legacyRoot, resolved);
    const segments = rel.split(path.sep).filter(Boolean);
    const resourceId = segments[0] ?? "";
    const filename = segments.slice(1).join("/");

    if (target.kind === "mini-app" && resourceId) {
      return (
        `⛔ Legacy path ${formatPaprPathForAgent(resolved)} is NOT the active workspace.\n` +
        `Active apps root: ${formatPaprPathForAgent(activeApps)}\n` +
        `Use read_app_file / edit_app_file / edit_app_file_lines({ appId: "${resourceId}", filename: "${filename || "…"}" }) — ` +
        `or edit_file({ path: "${formatPaprPathForAgent(path.join(activeApps, rel))}", ... }).\n` +
        `Never write_file or bash to ~/Papr/apps/ when org/namespace workspace is active.`
      );
    }

    if (target.kind === "job" && resourceId) {
      return (
        `⛔ Legacy path ${formatPaprPathForAgent(resolved)} is NOT the active workspace.\n` +
        `Active jobs root: ${formatPaprPathForAgent(activeJobs)}\n` +
        `Use edit_file({ path: "${formatPaprPathForAgent(path.join(activeJobs, rel))}", ... }) or job tools.\n` +
        `Never write_file or bash to ~/Papr/Jobs/ at the Papr root when org/namespace workspace is active.`
      );
    }

    return (
      `⛔ Legacy Papr path ${formatPaprPathForAgent(resolved)} is not the active workspace.\n` +
      `Active root: ${formatPaprPathForAgent(activeRoot)}`
    );
  }

  return null;
}

/** True when a grep/search path targets Papr mini-apps or jobs (flat or org/namespace layout). */
export function isPaprAppsOrJobsSearchPath(rawPath: string): boolean {
  const normalized = rawPath.replace(/\\/g, "/");
  if (/Papr\/apps\//i.test(normalized)) return true;
  if (/Papr\/(?:Jobs|jobs)\//i.test(normalized)) return true;
  if (/\/orgs\/[^/]+\/namespaces\/[^/]+\/(?:apps|Jobs|jobs)\//i.test(normalized)) {
    return true;
  }
  return false;
}
