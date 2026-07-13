/**
 * Install cloud mini-app source into local Paprwork (fork or track).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CLOUD_APP_REQUIREMENTS_FILENAME,
  parseRequirementsFileContent,
  readAppRequirements,
} from "./cloudAppRequirements.js";
import type { RequiredKeySpec } from "../../core/types/bundles.js";
import type {
  CloudAppInstallMode,
  CloudAppLineageFile,
} from "../../core/types/cloudAppLineage.js";
import { serializeCloudAppLineageFile } from "../../core/utils/cloudAppLineage.js";
import { cloudApiFetch } from "../utils/cloudApiClient.js";
import {
  getAppService,
  type AppFile,
  type MiniApp,
} from "./AppService.js";

interface MemoryInstallResponse {
  mode: CloudAppInstallMode;
  source: {
    orgId: string;
    namespaceId: string;
    userId: string;
    appId: string;
    slug: string;
  };
  repoPath: string;
  cloneUrl: string;
  token: string;
  expiresAt: string;
  lineageId: string;
}

export interface CloudAppInstallInput {
  namespaceId: string;
  slug: string;
  mode?: CloudAppInstallMode;
  shareToken?: string;
}

export interface CloudAppInstallResult {
  app: MiniApp;
  lineageId: string;
  mode: CloudAppInstallMode;
  sourceAppId: string;
  sourceSlug: string;
  requirements: RequiredKeySpec[];
}

async function runCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed (${code ?? "unknown"}): ${stderr.trim()}`,
        ),
      );
    });
  });
}

function authCloneUrl(cloneUrl: string, token: string): string {
  const normalized = cloneUrl.replace(/^https:\/\//, "");
  return `https://x-access-token:${token}@${normalized}`;
}

async function collectAppFiles(
  rootDir: string,
  baseDir: string = rootDir,
): Promise<AppFile[]> {
  const files: AppFile[] = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "papr-cloud-lineage.json") continue;

    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectAppFiles(fullPath, baseDir)));
      continue;
    }

    const relative = path.relative(baseDir, fullPath);
    const content = await fs.readFile(fullPath, "utf8");
    files.push({ filename: relative, content });
  }

  return files;
}

async function cloneAppSource(
  prepare: MemoryInstallResponse,
): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "papr-cloud-install-"));
  const repoDir = path.join(tempRoot, "repo");

  const cloneUrl = authCloneUrl(prepare.cloneUrl, prepare.token);
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  };

  await runCommand(
    "git",
    ["clone", "--filter=blob:none", "--sparse", cloneUrl, repoDir],
    { env, timeoutMs: 180_000 },
  );
  await runCommand(
    "git",
    ["sparse-checkout", "set", prepare.repoPath.replace(/\\/g, "/")],
    { cwd: repoDir, env },
  );

  return path.join(repoDir, prepare.repoPath);
}

function resolveTitle(files: AppFile[], slug: string): string {
  const metadata = files.find((file) => file.filename === "metadata.json");
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata.content) as { title?: string };
      if (parsed.title?.trim()) {
        return parsed.title.trim();
      }
    } catch {
      /* ignore */
    }
  }
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveDescription(files: AppFile[], fallback: string): string {
  const metadata = files.find((file) => file.filename === "metadata.json");
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata.content) as { description?: string };
      if (parsed.description?.trim()) {
        return parsed.description.trim();
      }
    } catch {
      /* ignore */
    }
  }
  return fallback;
}

function resolveIcon(files: AppFile[]): string | undefined {
  const metadata = files.find((file) => file.filename === "metadata.json");
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata.content) as { icon?: string };
      if (parsed.icon?.trim()) {
        return parsed.icon.trim();
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export class CloudAppInstallService {
  async prepareInstall(
    input: CloudAppInstallInput,
  ): Promise<MemoryInstallResponse> {
    const response = await cloudApiFetch("/v1/cloud/apps/install", {
      method: "POST",
      body: {
        namespaceId: input.namespaceId,
        slug: input.slug,
        mode: input.mode ?? "fork",
        shareToken: input.shareToken,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Cloud install prepare failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }

    return (await response.json()) as MemoryInstallResponse;
  }

  async installApp(input: CloudAppInstallInput): Promise<CloudAppInstallResult> {
    const prepare = await this.prepareInstall(input);
    const sourceDir = await cloneAppSource(prepare);
    const files = await collectAppFiles(sourceDir);

    if (files.length === 0) {
      throw new Error(
        `No app files found at ${prepare.repoPath} in owner repo`,
      );
    }

    const title = resolveTitle(files, prepare.source.slug);
    const description = resolveDescription(
      files,
      `Installed from Papr Cloud (${prepare.source.slug})`,
    );
    const icon = resolveIcon(files);

    const appService = getAppService();
    const app = await appService.createApp(
      title,
      description,
      files,
      icon,
    );

    const lineage: CloudAppLineageFile = {
      schemaVersion: "1.1.0",
      lineageId: prepare.lineageId,
      mode: prepare.mode,
      source: prepare.source,
      installedAt: new Date().toISOString(),
      ...(prepare.mode === "track"
        ? {
            lastSyncedAt: new Date().toISOString(),
            syncSnapshot: Object.fromEntries(
              files.map((file) => [
                file.filename.replace(/\\/g, "/"),
                createHash("sha256").update(file.content, "utf8").digest("hex"),
              ]),
            ),
          }
        : {}),
    };

    const paprDir = path.join(os.homedir(), "Papr");
    const lineagePath = path.join(paprDir, "apps", app.id, "papr-cloud-lineage.json");
    await fs.writeFile(
      lineagePath,
      serializeCloudAppLineageFile(lineage),
      "utf8",
    );

    const requirementsFile = files.find(
      (file) => file.filename === CLOUD_APP_REQUIREMENTS_FILENAME,
    );
    const requirements = requirementsFile
      ? parseRequirementsFileContent(requirementsFile.content)
      : readAppRequirements(paprDir, app.id);

    return {
      app,
      lineageId: prepare.lineageId,
      mode: prepare.mode,
      sourceAppId: prepare.source.appId,
      sourceSlug: prepare.source.slug,
      requirements,
    };
  }
}

let instance: CloudAppInstallService | null = null;

export function getCloudAppInstallService(): CloudAppInstallService {
  if (!instance) {
    instance = new CloudAppInstallService();
  }
  return instance;
}
