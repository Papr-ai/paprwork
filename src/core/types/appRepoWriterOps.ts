/**
 * Sync V3 app-repo-writer ops contract (frozen §8.2).
 * @see docs/SYNC_ARCHITECTURE_V3.md §1
 */

import { z } from "zod";

/** Git blob OID at last sync; empty string when file was absent locally. */
export const AppRepoOpFileSchema = z.object({
  path: z.string().min(1),
  /** null = delete path at HEAD. */
  content: z.string().nullable(),
  parentHash: z.string(),
});

export const AppRepoOpsRequestSchema = z.object({
  files: z.array(AppRepoOpFileSchema).min(1),
  author: z.string().min(1),
  message: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

export const AppRepoOpsSuccessResponseSchema = z.object({
  commitSha: z.string().min(1),
  files: z.array(
    z.object({
      path: z.string().min(1),
      blobOid: z.string().min(1),
    }),
  ),
});

export const AppRepoOpsConflictArtifactSchema = z.object({
  path: z.string().min(1),
  expectedParentHash: z.string(),
  actualBlobOid: z.string().nullable(),
});

export const AppRepoOpsConflictResponseSchema = z.object({
  conflict: z.literal(true),
  artifacts: z.array(AppRepoOpsConflictArtifactSchema).min(1),
});

export const AppRepoHeadFileSchema = z.object({
  path: z.string().min(1),
  blobOid: z.string().min(1),
});

export const AppRepoHeadResponseSchema = z.object({
  commitSha: z.string().min(1),
  files: z.array(AppRepoHeadFileSchema),
});

export type AppRepoOpFile = z.infer<typeof AppRepoOpFileSchema>;
export type AppRepoOpsRequest = z.infer<typeof AppRepoOpsRequestSchema>;
export type AppRepoOpsSuccessResponse = z.infer<
  typeof AppRepoOpsSuccessResponseSchema
>;
export type AppRepoOpsConflictResponse = z.infer<
  typeof AppRepoOpsConflictResponseSchema
>;
export type AppRepoHeadResponse = z.infer<typeof AppRepoHeadResponseSchema>;

export const SYNC_OID_CACHE_FILENAME = "sync-oid-cache.json";
export const SYNC_OUTBOX_FILENAME = "sync-outbox.jsonl";
