/**
 * Reads papr-cloud-lineage.json from installed mini-apps.
 */

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type {
  CloudAppInstallMode,
  CloudAppLineageFile,
} from "../../core/types/cloudAppLineage.js";
import { parseCloudAppLineageFile } from "../../core/utils/cloudAppLineage.js";

export const CLOUD_LINEAGE_FILENAME = "papr-cloud-lineage.json";

export interface CloudLineageAppEntry {
  appId: string;
  mode: CloudAppInstallMode;
  sourceAppId: string;
  sourceSlug: string;
  sourceNamespaceId: string;
  installedAt: string;
  lastSyncedAt?: string;
}

export interface CloudLineageIndex {
  byAppId: Record<string, CloudLineageAppEntry>;
  /** `${namespaceId}:${slug}` → local fork/track app IDs */
  bySourceKey: Record<string, string[]>;
}

function sourceKey(namespaceId: string, slug: string): string {
  return `${namespaceId}:${slug}`;
}

export class CloudAppLineageService {
  constructor(private readonly appsDir: string) {}

  async readLineageForApp(appId: string): Promise<CloudLineageAppEntry | null> {
    const filePath = path.join(this.appsDir, appId, CLOUD_LINEAGE_FILENAME);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = parseCloudAppLineageFile(raw);
      if (!parsed) return null;
      return toEntry(appId, parsed);
    } catch {
      return null;
    }
  }

  async buildIndex(): Promise<CloudLineageIndex> {
    const byAppId: Record<string, CloudLineageAppEntry> = {};
    const bySourceKey: Record<string, string[]> = {};

    let entries: string[];
    try {
      entries = await fs.readdir(this.appsDir);
    } catch {
      return { byAppId, bySourceKey };
    }

    await Promise.all(
      entries.map(async (appId) => {
        const lineage = await this.readLineageForApp(appId);
        if (!lineage) return;
        byAppId[appId] = lineage;
        const key = sourceKey(lineage.sourceNamespaceId, lineage.sourceSlug);
        const list = bySourceKey[key] ?? [];
        list.push(appId);
        bySourceKey[key] = list;
      }),
    );

    return { byAppId, bySourceKey };
  }
}

function toEntry(
  appId: string,
  file: CloudAppLineageFile,
): CloudLineageAppEntry {
  return {
    appId,
    mode: file.mode,
    sourceAppId: file.source.appId,
    sourceSlug: file.source.slug,
    sourceNamespaceId: file.source.namespaceId,
    installedAt: file.installedAt,
    lastSyncedAt: file.lastSyncedAt,
  };
}

let singleton: CloudAppLineageService | null = null;

function defaultAppsDir(): string {
  return path.join(os.homedir(), "Papr", "apps");
}

export function getCloudAppLineageService(
  appsDir?: string,
): CloudAppLineageService {
  if (!singleton || appsDir) {
    singleton = new CloudAppLineageService(appsDir ?? defaultAppsDir());
  }
  return singleton;
}
