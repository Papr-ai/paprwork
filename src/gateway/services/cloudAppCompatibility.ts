/**
 * Full cloud compatibility scan for a mini-app and its linked jobs.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { CloudCompatibilityReport } from "../../core/types/cloudAppCompatibility.js";
import { getPaprAppsRoot } from "../../core/utils/paprRoot.js";
import {
  mergeCloudCompatibilityFindings,
  scanJobCloudCompatibility,
  scanMiniAppCloudCompatibility,
} from "../utils/miniAppCloudCompatibility.js";
import { getAppService } from "./AppService.js";
import { getJobsService } from "./JobsService.js";

const SCAN_EXTENSIONS = new Set([
  ".html",
  ".css",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
]);

const JOB_FILE_EXTENSIONS = new Set([".js", ".ts", ".mjs", ".cjs", ".py", ".sh"]);

const JOB_ID_IN_APP =
  /(?:triggerJob|runLinkedInJob|AUTH_JOB_ID|KEEPALIVE_JOB_ID|SENDER_JOB_ID|jobId\s*[:=]\s*['"`])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

async function collectAppFiles(appDir: string): Promise<Map<string, string>> {
  const fileContents = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const rel = path.relative(appDir, fullPath);

      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules") continue;
        await walk(fullPath);
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!SCAN_EXTENSIONS.has(ext) && entry.name !== "data-sources.json") {
        continue;
      }

      try {
        const content = await fs.readFile(fullPath, "utf8");
        fileContents.set(rel, content);
      } catch {
        // skip unreadable files
      }
    }
  }

  await walk(appDir);
  return fileContents;
}

function extractJobIdsFromApp(fileContents: Map<string, string>): Set<string> {
  const jobIds = new Set<string>();
  for (const content of fileContents.values()) {
    for (const match of content.matchAll(JOB_ID_IN_APP)) {
      jobIds.add(match[1].toLowerCase());
    }
  }
  return jobIds;
}

async function collectJobScriptFiles(
  jobDir: string,
  command: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const commandMatch = command.match(/(?:node|python3?)\s+(\S+)/);
  if (commandMatch) {
    const scriptRel = commandMatch[1].replace(/^\.\//, "");
    const scriptPath = path.join(jobDir, scriptRel);
    try {
      files.set(scriptRel, await fs.readFile(scriptPath, "utf8"));
    } catch {
      // main script missing
    }
  }

  let entries;
  try {
    entries = await fs.readdir(jobDir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!JOB_FILE_EXTENSIONS.has(ext)) continue;
    if (files.has(entry.name)) continue;
    try {
      const content = await fs.readFile(path.join(jobDir, entry.name), "utf8");
      if (/puppeteer|9222|chrome-manager|linkedin-chrome|connectOverCDP/i.test(content)) {
        files.set(entry.name, content);
      }
    } catch {
      // skip
    }
  }

  return files;
}

export async function scanAppCloudCompatibility(
  appId: string,
): Promise<CloudCompatibilityReport> {
  const appService = getAppService();
  await appService.initialize();
  const jobsService = getJobsService();
  await jobsService.initialize();

  const appDir = path.join(getPaprAppsRoot(), appId);
  const fileContents = await collectAppFiles(appDir);

  let dataSourcesRaw: string | undefined;
  try {
    dataSourcesRaw = await fs.readFile(
      path.join(appDir, "data-sources.json"),
      "utf8",
    );
  } catch {
    dataSourcesRaw = undefined;
  }

  const appFindings = scanMiniAppCloudCompatibility(fileContents, dataSourcesRaw);

  const jobIds = extractJobIdsFromApp(fileContents);
  try {
    const config = await appService.getDataSourcesConfig(appId);
    for (const source of config.sources) {
      if (source.jobId) jobIds.add(source.jobId.toLowerCase());
    }
  } catch {
    // app missing from index — still scan files
  }

  const linkedJobs = await jobsService.listJobs({ appId });
  for (const job of linkedJobs) {
    jobIds.add(job.id.toLowerCase());
  }

  const jobFindingGroups = [];
  for (const jobId of jobIds) {
    const job = await jobsService.getJob(jobId);
    if (!job) continue;
    const jobDir = await jobsService.getJobPath(jobId);
    if (!jobDir) continue;
    const extraFiles = await collectJobScriptFiles(jobDir, job.command ?? "");
    jobFindingGroups.push(
      scanJobCloudCompatibility(jobId, job.name ?? jobId, job.command ?? "", extraFiles),
    );
  }

  return mergeCloudCompatibilityFindings([appFindings, ...jobFindingGroups]);
}
