import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type {
  BundleDatabaseSpec,
  BundleJobSpec,
  BundleManifest,
  CommunityRegistryEntry,
  RuntimeType,
} from "../../core/types/bundles.js";
import {
  BUNDLE_SCHEMA_VERSION,
  parseBundleManifest,
  parseValidRegistryEntries,
} from "../../core/types/bundles.js";
import { AppService, getAppService, type MiniApp } from "./AppService.js";
import {
  JobsService,
  getJobsService,
  type JobRecord,
  type JobType,
} from "./JobsService.js";

export interface ExportBundleInput {
  appId: string;
  bundleId: string;
  name: string;
  version: string;
  description?: string;
  minPaprworkVersion?: string;
  jobIds: string[];
  sqlite?: BundleDatabaseSpec[];
  /** Keep database files, logs, and caches in the bundle (user explicitly wants to share data) */
  includeData?: boolean;
  /** Override auto-detected platform. If omitted, platforms are detected from job types and source files. */
  platform?: Platform[];
}

export interface ImportBundleInput {
  sourcePath: string;
}

export interface BundleSummary {
  bundleId: string;
  name: string;
  version: string;
  path: string;
  createdAt: string;
}

export type { CommunityRegistryEntry };

export interface CommunityRegistry {
  schemaVersion: string;
  bundles: CommunityRegistryEntry[];
}

export interface ImportCommunityBundleInput {
  bundleId: string;
  repoPath: string;
}

const COMMUNITY_REGISTRY_URL =
  "https://raw.githubusercontent.com/Papr-ai/paprwork-community-apps/main/registry.json";
const COMMUNITY_REPO_URL =
  "https://github.com/Papr-ai/paprwork-community-apps.git";

let bundleServiceInstance: BundleService | null = null;

function mapJobTypeToRuntime(type: JobType): RuntimeType {
  if (type === "shell") {
    return "bash";
  }
  if (type === "subagent") {
    return "agent";
  }
  if (
    type === "bash" ||
    type === "node" ||
    type === "python" ||
    type === "swift" ||
    type === "agent"
  ) {
    return type;
  }
  return "bash";
}

function mapRuntimeToJobType(type: RuntimeType): JobType {
  if (type === "bash") {
    return "bash";
  }
  if (
    type === "node" ||
    type === "python" ||
    type === "swift" ||
    type === "agent"
  ) {
    return type;
  }
  return "shell";
}

/** File patterns that contain user data and must be removed from bundles */
const SCRUB_PATTERNS: RegExp[] = [
  /\.db$/,
  /\.db-shm$/,
  /\.db-wal$/,
  /\.sqlite$/,
  /\.sqlite3$/,
  /\.log$/,
];

/** Directory names that contain user data or build artifacts */
const SCRUB_DIRS = new Set([
  "logs",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  ".versions",
  "data",
]);

export interface ScrubReport {
  removedFiles: string[];
  removedDirs: string[];
  totalBytesRemoved: number;
}

export interface PortabilityWarning {
  file: string;
  line: number;
  issue: string;
  snippet: string;
}

export interface PortabilityReport {
  warnings: PortabilityWarning[];
  portable: boolean;
}

/**
 * Recursively remove private data files and directories from an exported
 * bundle path. Returns a report of what was removed.
 */
async function scrubPrivateData(bundlePath: string): Promise<ScrubReport> {
  const report: ScrubReport = {
    removedFiles: [],
    removedDirs: [],
    totalBytesRemoved: 0,
  };

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(bundlePath, fullPath);

      if (entry.isDirectory()) {
        if (SCRUB_DIRS.has(entry.name)) {
          const size = await getDirSize(fullPath);
          await fs.rm(fullPath, { recursive: true, force: true });
          report.removedDirs.push(relPath);
          report.totalBytesRemoved += size;
        } else {
          await walk(fullPath);
        }
      } else if (SCRUB_PATTERNS.some((p) => p.test(entry.name))) {
        const stat = await fs.stat(fullPath).catch(() => null);
        const size = stat?.size ?? 0;
        await fs.rm(fullPath, { force: true });
        report.removedFiles.push(relPath);
        report.totalBytesRemoved += size;
      }
    }
  }

  await walk(bundlePath);
  return report;
}

async function getDirSize(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await getDirSize(full);
      } else {
        const stat = await fs.stat(full).catch(() => null);
        total += stat?.size ?? 0;
      }
    }
  } catch {
    /* ignore errors */
  }
  return total;
}

/** Fields to keep in job.json during export (everything else is stripped) */
const JOB_JSON_KEEP_FIELDS = new Set([
  "id",
  "name",
  "type",
  "folder",
  "command",
  "requirements",
  "dependsOn",
  "runtimeCalls",
  "retries",
  "deliver",
  "retentionDays",
  "schedule",
  "subAgentId",
  "outputMode",
  "outputSchema",
  "maxTurns",
  "memoryPolicy",
]);

/**
 * Strip runtime state and private data from a copied job.json,
 * keeping only the job definition fields needed for portability.
 * Resets status to "pending" and sets fresh timestamps.
 */
async function sanitizeJobJson(jobJsonPath: string): Promise<void> {
  try {
    const raw = await fs.readFile(jobJsonPath, "utf8");
    const full = JSON.parse(raw) as Record<string, unknown>;
    const clean: Record<string, unknown> = {};

    for (const key of JOB_JSON_KEEP_FIELDS) {
      if (key in full && full[key] !== undefined) {
        clean[key] = full[key];
      }
    }

    clean.status = "pending";
    clean.createdAt = new Date().toISOString();
    clean.updatedAt = clean.createdAt;

    await fs.writeFile(jobJsonPath, JSON.stringify(clean, null, 2), "utf8");
  } catch {
    // No job.json or parse error — skip
  }
}

/** Map provider names to the API key they require */
const PROVIDER_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-codex": "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

/**
 * Items that look like env var names but are NOT API keys.
 * These get picked up from job.requirements or file scanning but shouldn't
 * appear in the bundle's requirements array.
 */
const KNOWN_NON_KEYS = new Set([
  "JOB_DIR",
  "JOB_DB",
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "PYTHONPATH",
  "NODE_PATH",
  "VIRTUAL_ENV",
]);

/**
 * Returns true if the string looks like an API key environment variable name.
 * Must be ALL_UPPERCASE_WITH_UNDERSCORES (allows digits). Rejects lowercase
 * package names (openai, pyobjc-framework-EventKit, ffmpeg, etc.) and
 * known built-in env vars.
 */
function isApiKeyName(name: string): boolean {
  if (!name || KNOWN_NON_KEYS.has(name)) return false;
  return /^[A-Z][A-Z0-9_]{2,}$/.test(name);
}

/** Patterns that indicate API key usage in source files */
const KEY_USAGE_PATTERNS = [
  /\$\{([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET))\}/g,
  /os\.environ\[['"]([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET))['"]\]/g,
  /os\.getenv\(['"]([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET))['"]\)/g,
  /process\.env\.([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET))/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET))['"]\]/g,
  /ENV\[['"]([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET))['"]\]/g,
];

/**
 * Auto-detect API keys required by the bundle's jobs.
 * Scans: job commands, job types/providers, explicit requirements, and source files.
 */
async function detectRequiredKeys(
  jobs: Array<{
    command?: string;
    type: string;
    requirements?: string[];
    subAgentId?: string;
  }>,
  bundlePath: string,
): Promise<string[]> {
  const keys = new Set<string>();

  for (const job of jobs) {
    // 1. ${KEY_NAME} in job commands
    const cmd = job.command ?? "";
    for (const pattern of KEY_USAGE_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(cmd)) !== null) {
        keys.add(match[1]);
      }
    }

    // 2. Agent/subagent jobs need their provider's key
    if (job.type === "agent" || job.type === "subagent") {
      if (job.subAgentId) {
        try {
          const { getSubAgentService } = await import("./SubAgentService.js");
          const profile = await getSubAgentService().getAgent(job.subAgentId);
          if (profile?.provider && PROVIDER_KEY_MAP[profile.provider]) {
            keys.add(PROVIDER_KEY_MAP[profile.provider]);
          }
        } catch {
          // SubAgentService not available — skip
        }
      } else {
        keys.add("ANTHROPIC_API_KEY");
      }
    }

    // 3. Explicit requirements on the job record — only include API-key-shaped names
    for (const req of job.requirements ?? []) {
      if (isApiKeyName(req)) {
        keys.add(req);
      }
    }
  }

  // 4. Scan text files in the bundle for key usage patterns
  async function scanDir(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.size > 512 * 1024) continue;
      let content: string;
      try {
        content = await fs.readFile(full, "utf8");
      } catch {
        continue;
      }
      for (const pattern of KEY_USAGE_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
          keys.add(match[1]);
        }
      }
    }
  }
  await scanDir(bundlePath);

  // Final pass: remove anything that isn't an API-key-shaped name
  for (const key of keys) {
    if (!isApiKeyName(key)) {
      keys.delete(key);
    }
  }

  return [...keys].sort();
}

type Platform = "macos" | "windows" | "linux";

const MACOS_INDICATORS = [
  /\bosascript\b/,
  /\bopen\s+-a\b/,
  /\bpbcopy\b/,
  /\bpbpaste\b/,
  /\bafplay\b/,
  /\bsay\b/,
  /\bbrew\s+(install|tap|cask)\b/,
  /\bdefaults\s+(write|read|delete)\b/,
  /\blaunchctl\b/,
  /\bAppleScript\b/i,
  /\/usr\/local\//,
  /\.app\b/,
  /\bsox\b/,
  /\brec\b.*\baudio\b/i,
  // Apple frameworks and bridge packages
  /\bEventKit\b/,
  /\bCoreAudio\b/,
  /\bAVFoundation\b/,
  /\bNSWorkspace\b/,
  /\bAppKit\b/,
  /\bCocoa\b/,
  /\bpyobjc\b/i,
  // macOS-specific tools
  /\bterminal-notifier\b/,
  /\bstat\s+-f%/,
  /\bsecurity\s+(find-identity|import|create-keychain)\b/,
  /\bcodesign\b/,
  /\bxcrun\b/,
  /\bxcode-select\b/,
  /\bmdfind\b/,
  /\bmdls\b/,
  // macOS paths
  /\/Library\/(Application Support|Preferences|LaunchAgents)\//,
];

const WINDOWS_INDICATORS = [
  /\bpowershell\b/i,
  /\bcmd\.exe\b/i,
  /\breg\.exe\b/i,
  /\bnet\s+start\b/i,
  /[A-Z]:\\/,
  /\.bat\b/,
  /\.ps1\b/,
  /\bchoco\s+install\b/i,
];

const LINUX_INDICATORS = [
  /\bapt-get\b/,
  /\bapt\s+install\b/,
  /\bsystemctl\b/,
  /\bjournalctl\b/,
  /\/etc\/init\.d\//,
  /\byum\s+install\b/,
  /\bdnf\s+install\b/,
  /\bpacman\s+-S\b/,
];

/**
 * Detect which platforms a bundle supports based on job types, commands,
 * and source file contents. Defaults to all platforms unless platform-specific
 * indicators are found.
 */
async function detectPlatforms(
  jobs: Array<{ command?: string; type: string }>,
  bundlePath: string,
): Promise<Platform[]> {
  const macOnly = new Set<string>();
  const winOnly = new Set<string>();
  const linuxOnly = new Set<string>();

  function scanText(text: string, source: string): void {
    for (const pattern of MACOS_INDICATORS) {
      if (pattern.test(text)) {
        macOnly.add(`${source}: ${pattern.source}`);
      }
    }
    for (const pattern of WINDOWS_INDICATORS) {
      if (pattern.test(text)) {
        winOnly.add(`${source}: ${pattern.source}`);
      }
    }
    for (const pattern of LINUX_INDICATORS) {
      if (pattern.test(text)) {
        linuxOnly.add(`${source}: ${pattern.source}`);
      }
    }
  }

  // Check job types
  for (const job of jobs) {
    if (job.type === "swift") {
      macOnly.add("swift job type");
    }
    if (job.command) {
      scanText(job.command, "job command");
    }
  }

  // Scan source files in the bundle
  async function scanDir(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      // Swift files = macOS only
      if (ext === ".swift") {
        macOnly.add("swift source file");
        continue;
      }
      if (ext === ".bat" || ext === ".ps1") {
        winOnly.add(`${ext} script file`);
        continue;
      }
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.size > 512 * 1024) continue;
      let content: string;
      try {
        content = await fs.readFile(full, "utf8");
      } catch {
        continue;
      }
      const relPath = path.relative(bundlePath, full);
      scanText(content, relPath);
    }
  }
  await scanDir(bundlePath);

  const hasMacSignals = macOnly.size > 0;
  const hasWinSignals = winOnly.size > 0;
  const hasLinuxSignals = linuxOnly.size > 0;

  // If no platform-specific signals found, it's cross-platform
  if (!hasMacSignals && !hasWinSignals && !hasLinuxSignals) {
    return ["macos", "windows", "linux"];
  }

  // If signals found for only one platform, restrict to that
  const platforms: Platform[] = [];
  if (hasMacSignals) platforms.push("macos");
  if (hasWinSignals) platforms.push("windows");
  if (hasLinuxSignals) platforms.push("linux");

  // If only restricting signals found (e.g. only mac signals),
  // the bundle is only for that platform
  return platforms;
}

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".swift",
  ".html",
  ".css",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".toml",
  ".cfg",
  ".ini",
  ".env",
  ".sql",
]);

/**
 * Build regex patterns that detect hardcoded user-specific paths.
 * Matches the current user's home dir and common home dir prefixes
 * with a username segment (e.g. /Users/john/, /home/john/, C:\Users\john\).
 */
function buildPortabilityPatterns(): Array<{
  pattern: RegExp;
  label: string;
}> {
  const home = os.homedir();
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return [
    {
      pattern: new RegExp(escaped, "g"),
      label: `hardcoded home directory (${home})`,
    },
    {
      pattern: /\/Users\/[a-zA-Z0-9._-]+\//g,
      label: "hardcoded macOS user path (/Users/<user>/...)",
    },
    {
      pattern: /\/home\/[a-zA-Z0-9._-]+\//g,
      label: "hardcoded Linux user path (/home/<user>/...)",
    },
    {
      pattern: /[A-Z]:\\Users\\[a-zA-Z0-9._-]+\\/g,
      label: "hardcoded Windows user path (C:\\Users\\<user>\\...)",
    },
  ];
}

/**
 * Scan all text files in the bundle for portability issues:
 * hardcoded absolute home paths, user-specific directories, etc.
 */
async function checkPortability(
  bundlePath: string,
): Promise<PortabilityReport> {
  const warnings: PortabilityWarning[] = [];
  const patterns = buildPortabilityPatterns();

  async function scanDir(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await scanDir(fullPath);
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext) && entry.name !== "manifest.json") {
        continue;
      }

      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat || stat.size > 512 * 1024) continue;

      let content: string;
      try {
        content = await fs.readFile(fullPath, "utf8");
      } catch {
        continue;
      }

      const relPath = path.relative(bundlePath, fullPath);
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { pattern, label } of patterns) {
          pattern.lastIndex = 0;
          if (pattern.test(line)) {
            const trimmed =
              line.length > 120 ? line.slice(0, 120) + "..." : line;
            warnings.push({
              file: relPath,
              line: i + 1,
              issue: label,
              snippet: trimmed.trim(),
            });
            break;
          }
        }
      }
    }
  }

  await scanDir(bundlePath);
  return { warnings, portable: warnings.length === 0 };
}

export class BundleService {
  private bundlesRootPath: string;
  private appService: AppService;
  private jobsService: JobsService;
  private initialized = false;

  constructor(
    appService: AppService = getAppService(),
    jobsService: JobsService = getJobsService(),
  ) {
    this.appService = appService;
    this.jobsService = jobsService;
    this.bundlesRootPath = path.join(os.homedir(), "PAPR", "bundles");
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await fs.mkdir(this.bundlesRootPath, { recursive: true });
    this.initialized = true;
  }

  private getBundlePath(bundleId: string): string {
    return path.join(this.bundlesRootPath, bundleId);
  }

  private getManifestPath(bundleId: string): string {
    return path.join(this.getBundlePath(bundleId), "manifest.json");
  }

  /**
   * Build a job spec for the manifest. Re-reads job.json from disk so that
   * any edits (even via sed/bash) are picked up instead of using stale
   * in-memory state.
   */
  private async buildJobSpec(
    job: JobRecord,
    jobPath: string,
  ): Promise<BundleJobSpec> {
    let command = job.command;

    // Re-read from disk in case agent edited job.json directly
    const jobJsonPath = path.join(jobPath, "job.json");
    try {
      const raw = await fs.readFile(jobJsonPath, "utf8");
      const diskJob = JSON.parse(raw) as Record<string, unknown>;
      if (typeof diskJob.command === "string") {
        command = diskJob.command;
      }
    } catch {
      // No job.json on disk — use in-memory record
    }

    return {
      id: job.id,
      name: job.name,
      type: mapJobTypeToRuntime(job.type),
      command,
      dependsOn: [],
      env: {},
      outputTables: [],
    };
  }

  /**
   * Scan app source files for job IDs referenced directly in code
   * (e.g. `const JOB_ID = "uuid"` or `fetch('/api/jobs/run', { body: { jobId: "uuid" } })`).
   * Returns job IDs found in code that match known jobs.
   */
  async scanAppSourceForJobIds(appDir: string): Promise<string[]> {
    const uuidPattern =
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const foundIds = new Set<string>();

    async function scanDir(dir: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (
            entry.name === "node_modules" ||
            entry.name === ".versions" ||
            entry.name.startsWith(".")
          )
            continue;
          await scanDir(full);
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (!TEXT_EXTENSIONS.has(ext)) continue;
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || stat.size > 512 * 1024) continue;
        let content: string;
        try {
          content = await fs.readFile(full, "utf8");
        } catch {
          continue;
        }
        const matches = content.match(uuidPattern);
        if (matches) {
          for (const m of matches) foundIds.add(m.toLowerCase());
        }
      }
    }
    await scanDir(appDir);

    // Filter to only UUIDs that match actual known jobs
    const validJobIds: string[] = [];
    for (const candidate of foundIds) {
      const job = await this.jobsService.getJob(candidate);
      if (job) validJobIds.push(candidate);
    }
    return validJobIds;
  }

  /**
   * Walk dependsOn + runtimeCalls recursively to discover all jobs
   * in the pipeline feeding into the seed job IDs.
   */
  async resolveFullJobPipeline(seedJobIds: string[]): Promise<string[]> {
    const visited = new Set<string>();
    const queue = [...seedJobIds];

    while (queue.length > 0) {
      const jobId = queue.pop()!;
      if (visited.has(jobId)) continue;
      visited.add(jobId);

      const job = await this.jobsService.getJob(jobId);
      if (!job) continue;

      for (const dep of job.dependsOn ?? []) {
        if (!visited.has(dep.jobId)) {
          queue.push(dep.jobId);
        }
      }
      for (const calleeId of job.runtimeCalls ?? []) {
        if (!visited.has(calleeId)) {
          queue.push(calleeId);
        }
      }
    }

    return [...visited];
  }

  async exportBundle(
    input: ExportBundleInput,
  ): Promise<{
    manifest: BundleManifest;
    scrubReport: ScrubReport;
    portabilityReport: PortabilityReport;
    detectedKeys: string[];
    detectedPlatform: Platform[];
    resolvedJobIds: string[];
  }> {
    await this.initialize();
    const app = await this.appService.getApp(input.appId);
    const appPath = await this.appService.getAppPath(input.appId);
    if (!app || !appPath) {
      throw new Error(`App not found: ${input.appId}`);
    }

    const destinationPath = this.getBundlePath(input.bundleId);
    try {
      await fs.access(destinationPath);
      throw new Error(`Bundle already exists: ${input.bundleId}`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }

    await fs.mkdir(destinationPath, { recursive: true });
    const appRelPath = path.join("apps", app.id);
    const appDest = path.join(destinationPath, appRelPath);
    await fs.mkdir(path.dirname(appDest), { recursive: true });
    await fs.cp(appPath, appDest, { recursive: true });

    // Clean data-sources.json: clear absolute dbPath (resolved from jobId at import)
    const dataSourcesFile = path.join(appDest, "data-sources.json");
    try {
      const dsRaw = await fs.readFile(dataSourcesFile, "utf8");
      const dataSources = JSON.parse(dsRaw) as Array<Record<string, unknown>>;
      if (Array.isArray(dataSources)) {
        const cleaned = dataSources.map((ds) => ({ ...ds, dbPath: "" }));
        await fs.writeFile(
          dataSourcesFile,
          JSON.stringify(cleaned, null, 2),
          "utf8",
        );
      }
    } catch {
      // No data-sources.json or parse error — fine, skip
    }

    // Scan app source for job IDs referenced directly in code
    const codeReferencedJobIds = await this.scanAppSourceForJobIds(appPath);
    const allSeedJobIds = [
      ...new Set([...input.jobIds, ...codeReferencedJobIds]),
    ];

    // Resolve the full job pipeline — walk dependsOn + runtimeCalls
    const resolvedJobIds = await this.resolveFullJobPipeline(allSeedJobIds);

    const jobSpecs: BundleJobSpec[] = [];
    const jobRecords: Array<{
      command?: string;
      type: string;
      requirements?: string[];
      subAgentId?: string;
    }> = [];
    for (const jobId of resolvedJobIds) {
      const job = await this.jobsService.getJob(jobId);
      const jobPath = await this.jobsService.getJobPath(jobId);
      if (!job || !jobPath) {
        throw new Error(`Job not found: ${jobId}`);
      }
      const jobRelPath = path.join("jobs", job.id);
      const jobDest = path.join(destinationPath, jobRelPath);
      await fs.mkdir(path.dirname(jobDest), { recursive: true });
      await fs.cp(jobPath, jobDest, { recursive: true });

      // Sanitize job.json: strip runtime state that contains private data
      await sanitizeJobJson(path.join(jobDest, "job.json"));

      jobSpecs.push(await this.buildJobSpec(job, jobPath));
      jobRecords.push({
        command: job.command,
        type: job.type,
        requirements: job.requirements,
        subAgentId: job.subAgentId,
      });
    }

    const scrubReport = input.includeData
      ? { removedFiles: [], removedDirs: [], totalBytesRemoved: 0 }
      : await scrubPrivateData(destinationPath);

    const portabilityReport = await checkPortability(destinationPath);

    // Also check job commands in the manifest for hardcoded paths
    const cmdPatterns = buildPortabilityPatterns();
    for (const job of jobSpecs) {
      const cmd = job.command ?? "";
      if (!cmd) continue;
      for (const { pattern, label } of cmdPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(cmd)) {
          portabilityReport.warnings.push({
            file: "manifest.json",
            line: 0,
            issue: `job "${job.name}" command has ${label}`,
            snippet: cmd.length > 120 ? cmd.slice(0, 120) + "..." : cmd,
          });
          portabilityReport.portable = false;
          break;
        }
      }
    }

    // Auto-detect API keys required by the bundle
    const detectedKeys = await detectRequiredKeys(jobRecords, destinationPath);

    // Use explicit platform override or auto-detect from job types and source files
    let detectedPlatform: Platform[];
    if (input.platform && input.platform.length > 0) {
      detectedPlatform = input.platform;
    } else {
      const jobsForPlatformCheck = jobRecords.map((j) => ({
        command: j.command ?? undefined,
        type: j.type,
      }));
      detectedPlatform = await detectPlatforms(
        jobsForPlatformCheck,
        destinationPath,
      );
    }

    const manifest: BundleManifest = parseBundleManifest({
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      bundleId: input.bundleId,
      name: input.name,
      version: input.version,
      createdAt: new Date().toISOString(),
      minPaprworkVersion: input.minPaprworkVersion ?? "2.0.0",
      description: input.description,
      ...(app.icon ? { icon: app.icon } : {}),
      requirements: detectedKeys,
      platform: detectedPlatform,
      app: {
        id: app.id,
        name: app.title,
        version: input.version,
        entryFile: "index.html",
        appPath: appRelPath,
        description: app.description,
      },
      jobs: jobSpecs,
      sqlite: input.sqlite ?? [],
      deploymentProfiles: [
        {
          id: "local-default",
          name: "Local Default",
          runtimeTarget: "local",
          environment: {},
        },
      ],
      sync: {
        preferredRoot: "~/PAPR",
        bundleSubpath: "bundles",
        cloudReady: true,
      },
    });

    await fs.writeFile(
      this.getManifestPath(input.bundleId),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
    return {
      manifest,
      scrubReport,
      portabilityReport,
      detectedKeys,
      detectedPlatform,
      resolvedJobIds,
    };
  }

  async importBundle(input: ImportBundleInput): Promise<BundleManifest> {
    await this.initialize();
    const sourceManifestPath = path.join(input.sourcePath, "manifest.json");
    const raw = await fs.readFile(sourceManifestPath, "utf8");
    const manifest = parseBundleManifest(JSON.parse(raw) as unknown);

    const destination = this.getBundlePath(manifest.bundleId);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(input.sourcePath, destination, { recursive: true });

    const appSource = path.join(destination, manifest.app.appPath);
    const appMetadata: MiniApp = {
      id: manifest.app.id,
      title: manifest.app.name,
      description: manifest.app.description ?? "",
      type: "app",
      createdAt: manifest.createdAt,
      updatedAt: new Date().toISOString(),
      favorite: false,
      ...(manifest.icon ? { icon: manifest.icon } : {}),
    };
    await this.appService.upsertApp(appMetadata, appSource);

    for (const jobSpec of manifest.jobs) {
      const sourceJobPath = path.join(destination, "jobs", jobSpec.id);
      const now = new Date().toISOString();
      const jobRecord: JobRecord = {
        id: jobSpec.id,
        name: jobSpec.name,
        type: mapRuntimeToJobType(jobSpec.type),
        status: "pending",
        command: jobSpec.command,
        createdAt: manifest.createdAt,
        updatedAt: now,
      };
      await this.jobsService.upsertJob(jobRecord, sourceJobPath);
    }

    // Fix data-sources.json: resolve dbPath from the local job paths
    const importedDataSourcesFile = path.join(
      this.appService.getAppsRootPath(),
      manifest.app.id,
      "data-sources.json",
    );
    try {
      const dsRaw = await fs.readFile(importedDataSourcesFile, "utf8");
      const dataSources = JSON.parse(dsRaw) as Array<Record<string, unknown>>;
      if (Array.isArray(dataSources)) {
        const fixed = await Promise.all(
          dataSources.map(async (ds) => {
            const jobId = ds.jobId as string | undefined;
            if (jobId) {
              const resolvedPath =
                await this.jobsService.getJobDatabasePath(jobId);
              if (resolvedPath) {
                return { ...ds, dbPath: resolvedPath };
              }
            }
            return ds;
          }),
        );
        await fs.writeFile(
          importedDataSourcesFile,
          JSON.stringify(fixed, null, 2),
          "utf8",
        );
      }
    } catch {
      // No data-sources.json — fine, skip
    }

    return manifest;
  }

  async fetchCommunityRegistry(): Promise<CommunityRegistry> {
    const response = await fetch(COMMUNITY_REGISTRY_URL);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch community registry: HTTP ${response.status}`,
      );
    }
    const raw: unknown = await response.json();
    const validated = parseValidRegistryEntries(raw);
    return validated;
  }

  async importCommunityBundle(
    input: ImportCommunityBundleInput,
  ): Promise<BundleManifest> {
    await this.initialize();

    const tempDir = path.join(
      os.tmpdir(),
      `papr-community-bundle-${Date.now()}`,
    );
    await fs.mkdir(tempDir, { recursive: true });

    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      await execAsync(
        `git clone --depth 1 ${COMMUNITY_REPO_URL} ${tempDir}`,
        { timeout: 120000 },
      );
    } catch (error) {
      throw new Error(
        `Failed to clone community repo: ${(error as Error).message}`,
      );
    }

    const bundlePath = path.join(tempDir, input.repoPath);
    try {
      await fs.access(path.join(bundlePath, "manifest.json"));
    } catch {
      throw new Error(
        `Bundle not found at path: ${input.repoPath}`,
      );
    }

    try {
      const manifest = await this.importBundle({ sourcePath: bundlePath });
      return manifest;
    } finally {
      fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
        /* best-effort cleanup */
      });
    }
  }

  async listBundles(): Promise<BundleSummary[]> {
    await this.initialize();
    const entries = await fs.readdir(this.bundlesRootPath, {
      withFileTypes: true,
    });
    const summaries: BundleSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const bundlePath = path.join(this.bundlesRootPath, entry.name);
      const manifestPath = path.join(bundlePath, "manifest.json");
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const manifest = parseBundleManifest(JSON.parse(raw) as unknown);
        summaries.push({
          bundleId: manifest.bundleId,
          name: manifest.name,
          version: manifest.version,
          path: bundlePath,
          createdAt: manifest.createdAt,
        });
      } catch {
        continue;
      }
    }
    return summaries.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }
}

export function getBundleService(): BundleService {
  if (!bundleServiceInstance) {
    bundleServiceInstance = new BundleService();
  }
  return bundleServiceInstance;
}

export async function initializeBundleService(): Promise<BundleService> {
  const service = getBundleService();
  await service.initialize();
  return service;
}
