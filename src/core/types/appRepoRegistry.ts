/**
 * Per-app GitHub repo registry types (Sync V3 Phase 1).
 * Server authoritative — desktop never constructs repo URLs.
 * @see docs/SYNC_V3_IMPLEMENTATION_PLAN.md §1.2
 */

import { z } from "zod";

/** Server-side AppRepoRecord (memory server / RepoRegistry). */
export interface AppRepoRecord {
  appId: string;
  namespaceId: string;
  githubOrg: string;
  repoName: string;
  shardId: string;
  cloneUrl: string;
  repoUrl: string;
  createdAt: string;
  /** Set when migrated from namespace monorepo. */
  legacyNamespaceRepo?: string;
}

const AppRepoRecordSchema = z
  .object({
    app_id: z.string().min(1).optional(),
    appId: z.string().min(1).optional(),
    namespace_id: z.string().min(1).optional(),
    namespaceId: z.string().min(1).optional(),
    github_org: z.string().min(1).optional(),
    githubOrg: z.string().min(1).optional(),
    repo_name: z.string().min(1).optional(),
    repoName: z.string().min(1).optional(),
    shard_id: z.string().min(1).optional(),
    shardId: z.string().min(1).optional(),
    clone_url: z.string().url().optional(),
    cloneUrl: z.string().url().optional(),
    repo_url: z.string().url().optional(),
    repoUrl: z.string().url().optional(),
    created_at: z.string().min(1).optional(),
    createdAt: z.string().min(1).optional(),
    legacy_namespace_repo: z.string().optional(),
    legacyNamespaceRepo: z.string().optional(),
  })
  .transform((raw): AppRepoRecord => {
    const appId = raw.appId ?? raw.app_id;
    const namespaceId = raw.namespaceId ?? raw.namespace_id;
    const githubOrg = raw.githubOrg ?? raw.github_org;
    const repoName = raw.repoName ?? raw.repo_name;
    const shardId = raw.shardId ?? raw.shard_id;
    const cloneUrl = raw.cloneUrl ?? raw.clone_url;
    const repoUrl = raw.repoUrl ?? raw.repo_url;
    const createdAt = raw.createdAt ?? raw.created_at;

    if (
      !appId ||
      !namespaceId ||
      !githubOrg ||
      !repoName ||
      !shardId ||
      !cloneUrl ||
      !repoUrl ||
      !createdAt
    ) {
      throw new Error("AppRepoRecord response missing required fields");
    }

    return {
      appId,
      namespaceId,
      githubOrg,
      repoName,
      shardId,
      cloneUrl,
      repoUrl,
      createdAt,
      ...(raw.legacyNamespaceRepo ?? raw.legacy_namespace_repo
        ? {
            legacyNamespaceRepo:
              raw.legacyNamespaceRepo ?? raw.legacy_namespace_repo,
          }
        : {}),
    };
  });

export function parseAppRepoRecord(payload: unknown): AppRepoRecord {
  return AppRepoRecordSchema.parse(payload);
}

/** Local cache file shape — keyed by appId. */
export interface AppRepoRegistryCacheFile {
  version: 1;
  updatedAt: string;
  records: Record<string, AppRepoRecord>;
}

export const APP_REPO_REGISTRY_CACHE_FILENAME = "app-repo-registry.json";
