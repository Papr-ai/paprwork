/**
 * Merge fork changes into owner's published app on change-request approve.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CLOUD_LINEAGE_FILENAME } from "./CloudAppLineageService.js";
import { getAppService } from "./AppService.js";
import { cloudApiFetch } from "../utils/cloudApiClient.js";

interface ChangeRequestRecord {
  id: string;
  sourceAppId: string;
  installedAppId: string;
  status: string;
}

export interface ChangeMergeResult {
  requestId: string;
  sourceAppId: string;
  installedAppId: string;
  mergedFiles: string[];
  skippedFiles: string[];
}

async function listAppFiles(appDir: string, baseDir: string = appDir): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(appDir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === CLOUD_LINEAGE_FILENAME) continue;

    const fullPath = path.join(appDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listAppFiles(fullPath, baseDir);
      for (const [rel, content] of nested) {
        files.set(rel, content);
      }
      continue;
    }

    const relative = path.relative(baseDir, fullPath).replace(/\\/g, "/");
    const content = await fs.readFile(fullPath, "utf8");
    files.set(relative, content);
  }

  return files;
}

async function fetchChangeRequest(requestId: string): Promise<ChangeRequestRecord | null> {
  const response = await cloudApiFetch("/v1/cloud/apps/changes/incoming");
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as { requests?: ChangeRequestRecord[] };
  return (body.requests ?? []).find((r) => r.id === requestId) ?? null;
}

export class CloudAppChangeMergeService {
  private readonly appsDir: string;

  constructor(appsDir?: string) {
    this.appsDir = appsDir ?? path.join(os.homedir(), "Papr", "apps");
  }

  async getChangeRequest(requestId: string): Promise<ChangeRequestRecord | null> {
    return fetchChangeRequest(requestId);
  }

  async mergeForkIntoSource(
    sourceAppId: string,
    installedAppId: string,
  ): Promise<ChangeMergeResult> {
    const sourceDir = path.join(this.appsDir, sourceAppId);
    const forkDir = path.join(this.appsDir, installedAppId);

    try {
      await fs.access(sourceDir);
      await fs.access(forkDir);
    } catch {
      throw new Error(
        "Local app folders missing — open both apps in Paprwork before approving merge",
      );
    }

    const forkFiles = await listAppFiles(forkDir);
    if (forkFiles.size === 0) {
      throw new Error("Fork app has no files to merge");
    }

    const appService = getAppService();
    const mergedFiles: string[] = [];
    const skippedFiles: string[] = [];

    for (const [filename, content] of forkFiles) {
      const written = await appService.writeAppFile(
        sourceAppId,
        filename,
        content,
      );
      if (written) {
        mergedFiles.push(filename);
      } else {
        skippedFiles.push(filename);
      }
    }

    void import("./CloudSyncService.js").then(({ getCloudSyncService }) => {
      void getCloudSyncService()?.pushNow();
    });

    return {
      requestId: "",
      sourceAppId,
      installedAppId,
      mergedFiles,
      skippedFiles,
    };
  }

  async mergeOnApprove(requestId: string): Promise<ChangeMergeResult> {
    const request = await fetchChangeRequest(requestId);
    if (!request) {
      throw new Error(`Change request ${requestId} not found`);
    }

    const result = await this.mergeForkIntoSource(
      request.sourceAppId,
      request.installedAppId,
    );
    return { ...result, requestId };
  }
}

export function fileContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

let instance: CloudAppChangeMergeService | null = null;

export function getCloudAppChangeMergeService(): CloudAppChangeMergeService {
  if (!instance) {
    instance = new CloudAppChangeMergeService();
  }
  return instance;
}
