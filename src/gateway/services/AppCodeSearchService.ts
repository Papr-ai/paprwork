/**
 * Code search for mini-app workspace — Papr Memory when available, keyword fallback otherwise.
 */

import { getPaprRoot } from "../../core/utils/paprRoot.js";
import * as path from "path";
import type { MemoryObject } from "@papr/memory/resources/shared.js";
import { getPaprClient, isPaprNotFoundError } from "../../core/tools/paprClient.js";
import { buildSearchPolicy } from "../utils/paprMemoryPolicy.js";
import { paprMemorySearchScopeSpread } from "../utils/memoryScopeResolver.js";
import type {
  AppWorkspaceFilesResult,
  WorkspaceFileKind,
} from "./appWorkspaceFiles.js";

export type AppCodeSearchScope = "all" | "app" | "jobs";
export type AppCodeSearchMode = "memory" | "keyword" | "hybrid";

export const MEMORY_SEARCH_UNAVAILABLE_NOTICE =
  "Memory search unavailable. Log into Papr for semantic search.";

export const MEMORY_SEARCH_TIMEOUT_NOTICE =
  "Semantic search timed out. Showing keyword matches.";

/** Papr Memory search can be slow (reranking + multi-project). */
const MEMORY_SEARCH_TIMEOUT_MS = 45_000;

export interface AppCodeSearchHit {
  memoryId: string;
  fileName: string;
  relativePath: string;
  projectId: string;
  projectType: "mini_app" | "job";
  language?: string;
  snippet: string;
  score?: number;
}

export interface AppCodeSearchResult {
  hits: AppCodeSearchHit[];
  query: string;
  mode: AppCodeSearchMode;
  notice?: string;
}

export interface AppCodeSearchParams {
  appId: string;
  query: string;
  /** Linked job IDs for this app — used to filter "all" scope results. */
  jobIds?: string[];
  scope?: AppCodeSearchScope;
  /** When scope is "jobs", restrict to these job IDs (defaults to all linked jobs). */
  jobFilter?: string[];
  limit?: number;
  /** keyword = local grep; memory = Papr only; hybrid = keyword first (caller merges). */
  mode?: "keyword" | "memory" | "hybrid";
}

interface ParsedPath {
  relativePath: string;
  projectId: string;
  projectType: "mini_app" | "job";
}

function readCustomMetadata(
  memory: MemoryObject,
): Record<string, string | number | boolean> {
  const raw = memory.customMetadata;
  if (!raw || typeof raw !== "object") {
    return {};
  }
  return raw as Record<string, string | number | boolean>;
}

function parseIndexedFilePath(
  filePath: string,
  paprDir: string,
): ParsedPath | null {
  const normalized = path.normalize(filePath);
  const appsRoot = path.join(paprDir, "apps");
  const jobsRoot = path.join(paprDir, "Jobs");

  if (normalized.startsWith(appsRoot + path.sep)) {
    const rest = normalized.slice(appsRoot.length + 1);
    const slash = rest.indexOf(path.sep);
    if (slash <= 0) return null;
    const projectId = rest.slice(0, slash);
    const relativePath = rest.slice(slash + 1);
    if (!relativePath) return null;
    return { projectId, relativePath, projectType: "mini_app" };
  }

  if (normalized.startsWith(jobsRoot + path.sep)) {
    const rest = normalized.slice(jobsRoot.length + 1);
    const slash = rest.indexOf(path.sep);
    if (slash <= 0) return null;
    const projectId = rest.slice(0, slash);
    const relativePath = rest.slice(slash + 1);
    if (!relativePath) return null;
    return { projectId, relativePath, projectType: "job" };
  }

  return null;
}

function buildSnippet(content: string, query: string, maxLen = 220): string {
  const trimmed = content.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }

  const lower = trimmed.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);
  let index = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0) {
      index = found;
      break;
    }
  }

  if (index < 0) {
    return `${trimmed.slice(0, maxLen - 1)}…`;
  }

  const start = Math.max(0, index - 60);
  const end = Math.min(trimmed.length, start + maxLen);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < trimmed.length ? "…" : "";
  return `${prefix}${trimmed.slice(start, end)}${suffix}`;
}

function hitFromMemory(
  memory: MemoryObject,
  query: string,
  paprDir: string,
): AppCodeSearchHit | null {
  const meta = readCustomMetadata(memory);
  const filePath =
    typeof meta.file_path === "string" ? meta.file_path : undefined;
  const fileName =
    typeof meta.file_name === "string"
      ? meta.file_name
      : filePath
        ? path.basename(filePath)
        : undefined;
  const projectId =
    typeof meta.project_id === "string" ? meta.project_id : undefined;
  const projectTypeRaw = meta.project_type;
  const projectType =
    projectTypeRaw === "mini_app" || projectTypeRaw === "job"
      ? projectTypeRaw
      : undefined;

  let relativePath = "";
  let resolvedProjectId = projectId ?? "";
  let resolvedProjectType: "mini_app" | "job" | undefined = projectType;

  if (filePath) {
    const parsed = parseIndexedFilePath(filePath, paprDir);
    if (parsed) {
      relativePath = parsed.relativePath;
      resolvedProjectId = parsed.projectId;
      resolvedProjectType = parsed.projectType;
    }
  }

  if (!relativePath || !resolvedProjectType || !resolvedProjectId) {
    return null;
  }

  const content = typeof memory.content === "string" ? memory.content : "";
  if (!content) {
    return null;
  }

  const language =
    typeof meta.language === "string" ? meta.language : undefined;

  return {
    memoryId: memory.id ?? "",
    fileName: fileName ?? path.basename(relativePath),
    relativePath,
    projectId: resolvedProjectId,
    projectType: resolvedProjectType,
    language,
    snippet: buildSnippet(content, query),
    score: typeof memory.score === "number" ? memory.score : undefined,
  };
}

function matchesScope(
  hit: AppCodeSearchHit,
  params: AppCodeSearchParams,
): boolean {
  const scope = params.scope ?? "all";
  const jobIds = new Set(params.jobIds ?? []);
  const jobFilter = params.jobFilter?.length ? new Set(params.jobFilter) : null;

  if (scope === "app") {
    return hit.projectType === "mini_app" && hit.projectId === params.appId;
  }

  if (scope === "jobs") {
    if (hit.projectType !== "job") {
      return false;
    }
    if (jobFilter) {
      return jobFilter.has(hit.projectId);
    }
    return jobIds.size === 0 || jobIds.has(hit.projectId);
  }

  if (hit.projectType === "mini_app") {
    return hit.projectId === params.appId;
  }
  return jobIds.size === 0 || jobIds.has(hit.projectId);
}

async function searchProject(
  client: Awaited<ReturnType<typeof getPaprClient>>,
  query: string,
  projectId: string,
  projectType: "mini_app" | "job",
  limit: number,
): Promise<MemoryObject[]> {
  try {
    const searchScope = await paprMemorySearchScopeSpread();
    const response = await client.memory.search({
      query,
      ...searchScope,
      max_memories: limit,
      max_nodes: 10,
      enable_agentic_graph: false,
      reranking_config: {
        reranking_enabled: true,
        reranking_provider: "cohere",
        reranking_model: "rerank-v3.5",
      },
      policy: buildSearchPolicy({ defaultDomain: "code" }),
      metadata: {
        category: "learning",
        role: "assistant",
        customMetadata: {
          source: "code_indexer",
          project_id: projectId,
          project_type: projectType,
        },
      },
    });
    return response.data?.memories ?? [];
  } catch (error) {
    if (isPaprNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

const TEXT_SEARCH_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".html",
  ".css",
  ".json",
  ".md",
  ".sql",
  ".txt",
  ".yaml",
  ".yml",
]);

interface SearchTarget {
  projectId: string;
  projectType: "mini_app" | "job";
  relativePath: string;
}

function detectLanguage(ext: string): string | undefined {
  const map: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".py": "Python",
  };
  return map[ext.toLowerCase()];
}

function isSearchableFile(relativePath: string, kind: WorkspaceFileKind): boolean {
  if (kind !== "file") {
    return false;
  }
  return TEXT_SEARCH_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function contentMatchesQuery(content: string, query: string): boolean {
  const lower = content.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) {
    return false;
  }
  return terms.every((term) => lower.includes(term));
}

function collectSearchTargets(
  workspace: AppWorkspaceFilesResult,
  params: AppCodeSearchParams,
): SearchTarget[] {
  const scope = params.scope ?? "all";
  const jobFilter = params.jobFilter?.length ? new Set(params.jobFilter) : null;
  const targets: SearchTarget[] = [];

  const includeApp = scope === "all" || scope === "app";
  const includeJobs = scope === "all" || scope === "jobs";

  if (includeApp && !jobFilter) {
    for (const file of workspace.appFiles) {
      if (!isSearchableFile(file.path, file.kind)) continue;
      targets.push({
        projectId: workspace.appId,
        projectType: "mini_app",
        relativePath: file.path,
      });
    }
  }

  if (includeJobs) {
    for (const job of workspace.jobs) {
      if (jobFilter && !jobFilter.has(job.jobId)) {
        continue;
      }
      for (const file of job.files) {
        if (!isSearchableFile(file.path, file.kind)) continue;
        targets.push({
          projectId: job.jobId,
          projectType: "job",
          relativePath: file.path,
        });
      }
    }
  }

  return targets;
}

async function isPaprMemoryAvailable(): Promise<boolean> {
  const { getApiKey } = await import("../utils/keyResolver.js");
  const apiKey = await getApiKey("PAPR_API_KEY");
  return Boolean(apiKey);
}

function shouldFallbackToKeyword(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("PAPR_API_KEY") ||
    message.includes("API key") ||
    message.includes("Authentication") ||
    message.includes("not configured")
  );
}

async function searchAppCodeByKeyword(
  params: AppCodeSearchParams,
): Promise<AppCodeSearchHit[]> {
  const query = params.query.trim();
  const { getAppService } = await import("./AppService.js");
  const { getJobsService } = await import("./JobsService.js");
  const appService = getAppService();
  const jobsService = getJobsService();
  await jobsService.initialize();

  const workspace = await appService.listWorkspaceFiles(params.appId);
  const targets = collectSearchTargets(workspace, params);
  const limit = Math.min(Math.max(params.limit ?? 12, 1), 30);
  const hits: AppCodeSearchHit[] = [];

  for (const target of targets) {
    if (hits.length >= limit) {
      break;
    }

    const content =
      target.projectType === "mini_app"
        ? await appService.readAppFile(workspace.appId, target.relativePath)
        : await jobsService.readJobFile(target.projectId, target.relativePath);

    if (!content || !contentMatchesQuery(content, query)) {
      continue;
    }

    hits.push({
      memoryId: "",
      fileName: path.basename(target.relativePath),
      relativePath: target.relativePath,
      projectId: target.projectId,
      projectType: target.projectType,
      language: detectLanguage(path.extname(target.relativePath)),
      snippet: buildSnippet(content, query),
    });
  }

  return hits;
}

async function searchViaMemory(params: AppCodeSearchParams): Promise<AppCodeSearchHit[]> {
  const query = params.query.trim();
  const client = await getPaprClient();
  const paprDir = getPaprRoot();
  const limit = Math.min(Math.max(params.limit ?? 12, 1), 30);
  const scope = params.scope ?? "all";

  let memories: MemoryObject[] = [];

  if (scope === "app") {
    memories = await searchProject(
      client,
      query,
      params.appId,
      "mini_app",
      limit,
    );
  } else if (scope === "jobs") {
    const targets =
      params.jobFilter?.length && params.jobFilter.length > 0
        ? params.jobFilter
        : (params.jobIds ?? []);
    if (targets.length === 0) {
      return [];
    }
    const batches = await Promise.all(
      targets.map((jobId) =>
        searchProject(client, query, jobId, "job", limit),
      ),
    );
    memories = batches.flat();
  } else {
    const jobTargets = params.jobIds ?? [];
    const batches = await Promise.all([
      searchProject(client, query, params.appId, "mini_app", limit),
      ...jobTargets.map((jobId) =>
        searchProject(client, query, jobId, "job", limit),
      ),
    ]);
    memories = batches.flat();
  }

  const seen = new Set<string>();
  const hits: AppCodeSearchHit[] = [];

  for (const memory of memories) {
    const hit = hitFromMemory(memory, query, paprDir);
    if (!hit || !hit.memoryId) continue;
    if (!matchesScope(hit, params)) continue;

    const dedupeKey = `${hit.projectType}:${hit.projectId}:${hit.relativePath}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    hits.push(hit);
    if (hits.length >= limit) break;
  }

  hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return hits;
}

function hitDedupeKey(hit: AppCodeSearchHit): string {
  return `${hit.projectType}:${hit.projectId}:${hit.relativePath}`;
}

/** Memory hits first (by score), then keyword-only matches. */
export function mergeAppCodeSearchHits(
  memoryHits: AppCodeSearchHit[],
  keywordHits: AppCodeSearchHit[],
  limit: number,
): AppCodeSearchHit[] {
  const seen = new Set<string>();
  const merged: AppCodeSearchHit[] = [];

  const sortedMemory = [...memoryHits].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0),
  );

  for (const hit of sortedMemory) {
    const key = hitDedupeKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }

  for (const hit of keywordHits) {
    if (merged.length >= limit) break;
    const key = hitDedupeKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }

  return merged.slice(0, limit);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function searchViaMemoryWithTimeout(
  params: AppCodeSearchParams,
): Promise<AppCodeSearchHit[]> {
  return withTimeout(
    searchViaMemory(params),
    MEMORY_SEARCH_TIMEOUT_MS,
    "Memory search timed out",
  );
}

export async function searchAppCodeInMemory(
  params: AppCodeSearchParams,
): Promise<AppCodeSearchResult> {
  const query = params.query.trim();
  if (!query) {
    return { hits: [], query, mode: "keyword" };
  }

  const mode = params.mode ?? "memory";
  const limit = Math.min(Math.max(params.limit ?? 12, 1), 30);

  if (mode === "keyword") {
    const hits = await searchAppCodeByKeyword(params);
    return { hits, query, mode: "keyword" };
  }

  if (mode === "hybrid") {
    const keywordHits = await searchAppCodeByKeyword(params);
    if (!(await isPaprMemoryAvailable())) {
      return {
        hits: keywordHits,
        query,
        mode: "hybrid",
        notice: MEMORY_SEARCH_UNAVAILABLE_NOTICE,
      };
    }
    try {
      const memoryHits = await searchViaMemoryWithTimeout(params);
      return {
        hits: mergeAppCodeSearchHits(memoryHits, keywordHits, limit),
        query,
        mode: "hybrid",
      };
    } catch (error) {
      const notice =
        error instanceof Error && error.message.includes("timed out")
          ? MEMORY_SEARCH_TIMEOUT_NOTICE
          : shouldFallbackToKeyword(error)
            ? MEMORY_SEARCH_UNAVAILABLE_NOTICE
            : undefined;
      if (!notice && !shouldFallbackToKeyword(error)) {
        throw error;
      }
      return {
        hits: keywordHits,
        query,
        mode: "hybrid",
        notice,
      };
    }
  }

  // memory-only (explicit or legacy default)
  if (await isPaprMemoryAvailable()) {
    try {
      const hits = await searchViaMemoryWithTimeout(params);
      return { hits, query, mode: "memory" };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("timed out")
      ) {
        return {
          hits: [],
          query,
          mode: "memory",
          notice: MEMORY_SEARCH_TIMEOUT_NOTICE,
        };
      }
      if (!shouldFallbackToKeyword(error)) {
        throw error;
      }
    }
  }

  const hits = await searchAppCodeByKeyword(params);
  return {
    hits,
    query,
    mode: "keyword",
    notice: MEMORY_SEARCH_UNAVAILABLE_NOTICE,
  };
}
