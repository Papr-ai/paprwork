/**
 * Tracks recent agent/user file edits and resolves UI focus into model context.
 */

import { execSync } from "child_process";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import { promises as fs, type Dirent } from "fs";
import path from "path";
import type {
  LastEditedFileRef,
  ResolvedAgentFocusContext,
  UiAgentFocusContext,
} from "../../core/types/agentFocus.js";
import {
  formatAgentFocusContext,
  mergeUiAndServerFocus,
} from "./agent/focusContextFormatter.js";

const MAX_TRACKED_EDITS = 12;

function appsRoot(): string {
  return path.join(getPaprRoot(), "apps");
}

function jobsRoot(): string {
  return path.join(getPaprRoot(), "Jobs");
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeKey(entry: LastEditedFileRef): string {
  return `${entry.kind}:${entry.path}:${entry.appId ?? ""}:${entry.jobId ?? ""}`;
}

function resolveGitRepoRoot(filePath: string): string | undefined {
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd: path.dirname(filePath),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const root = out.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

const JOB_DIR_SKIP = new Set([
  ".versions",
  "node_modules",
  "venv",
  ".venv",
  "__pycache__",
  ".git",
]);

async function listJobFiles(jobDir: string, maxFiles: number): Promise<string[]> {
  const files: string[] = [];

  const walk = async (dir: string, base: string): Promise<void> => {
    if (files.length >= maxFiles) return;
    let items: Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (files.length >= maxFiles) return;
      if (JOB_DIR_SKIP.has(item.name)) continue;
      const rel = base ? `${base}/${item.name}` : item.name;
      if (item.isDirectory()) {
        await walk(path.join(dir, item.name), rel);
      } else {
        files.push(rel);
      }
    }
  };

  await walk(jobDir, "");
  return files;
}

function classifyAbsolutePath(
  absolutePath: string,
): Omit<LastEditedFileRef, "editedAt"> | null {
  const normalized = path.normalize(absolutePath);

  if (normalized.startsWith(appsRoot() + path.sep)) {
    const rel = path.relative(appsRoot(), normalized);
    const parts = rel.split(path.sep);
    const appId = parts[0];
    const filename = parts.slice(1).join("/");
    if (!appId || !filename) return null;
    return {
      kind: "mini_app",
      path: filename,
      appId,
      filename,
    };
  }

  if (normalized.startsWith(jobsRoot() + path.sep)) {
    const rel = path.relative(jobsRoot(), normalized);
    const parts = rel.split(path.sep);
    const jobId = parts[0];
    const filename = parts.slice(1).join("/");
    if (!jobId || !filename) return null;
    return {
      kind: "job",
      path: filename,
      jobId,
      filename,
    };
  }

  const repoRoot = resolveGitRepoRoot(normalized);
  if (repoRoot) {
    const rel = path.relative(repoRoot, normalized);
    if (!rel.startsWith("..")) {
      return {
        kind: "repo_file",
        path: rel,
        repoRoot,
      };
    }
  }

  return {
    kind: "repo_file",
    path: normalized,
  };
}

export class AgentFocusContextService {
  private edits: LastEditedFileRef[] = [];

  recordMiniAppEdit(appId: string, filename: string): void {
    this.pushEdit({
      kind: "mini_app",
      path: filename,
      appId,
      filename,
      editedAt: nowIso(),
    });
  }

  recordJobEdit(jobId: string, filename: string): void {
    this.pushEdit({
      kind: "job",
      path: filename,
      jobId,
      filename,
      editedAt: nowIso(),
    });
  }

  recordAbsolutePathEdit(absolutePath: string): void {
    const classified = classifyAbsolutePath(path.resolve(absolutePath));
    if (!classified) return;
    this.pushEdit({
      ...classified,
      editedAt: nowIso(),
    });
  }

  getLastEdited(): LastEditedFileRef[] {
    return [...this.edits];
  }

  private pushEdit(entry: LastEditedFileRef): void {
    const key = normalizeKey(entry);
    this.edits = this.edits.filter((e) => normalizeKey(e) !== key);
    this.edits.unshift(entry);
    if (this.edits.length > MAX_TRACKED_EDITS) {
      this.edits.length = MAX_TRACKED_EDITS;
    }
  }

  async resolveFocusContext(
    ui?: UiAgentFocusContext,
  ): Promise<ResolvedAgentFocusContext | undefined> {
    const server: ResolvedAgentFocusContext = {
      lastEdited: this.getLastEdited(),
    };

    if (ui?.activeApp?.appId) {
      server.activeApp = { ...ui.activeApp };
      try {
        const { getAppService } = await import("./AppService.js");
        const appService = getAppService();
        await appService.initialize();
        const appDir = path.join(appsRoot(), ui.activeApp.appId);
        const entries = await fs.readdir(appDir);
        server.activeApp.files = entries.filter(
          (name) =>
            !name.startsWith(".") &&
            name !== "data-sources.json" &&
            name !== ".versions" &&
            name !== "dist",
        );
      } catch {
        // App dir unreadable — still inject appId/title
      }
    }

    if (ui?.activeJob?.jobId) {
      server.activeJob = { ...ui.activeJob };
      try {
        const jobDir = path.join(jobsRoot(), ui.activeJob.jobId);
        server.activeJob.files = await listJobFiles(jobDir, 24);
      } catch {
        // Job dir unreadable — still inject jobId/name
      }
    }

    return mergeUiAndServerFocus(ui, server);
  }

  async buildFocusMessage(
    ui?: UiAgentFocusContext,
  ): Promise<string | undefined> {
    const resolved = await this.resolveFocusContext(ui);
    return formatAgentFocusContext(resolved);
  }
}

let singleton: AgentFocusContextService | null = null;

export function getAgentFocusContextService(): AgentFocusContextService {
  if (!singleton) {
    singleton = new AgentFocusContextService();
  }
  return singleton;
}
