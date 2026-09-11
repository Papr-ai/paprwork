/**
 * Persists code summaries to Papr Memory with upsert semantics.
 */

import { Papr } from '@papr/memory';
import { buildCodeIndexAddPolicy } from '../../utils/paprMemoryPolicy.js';
import { paprMemoryScopeSpread } from '../../utils/memoryScopeResolver.js';
import { isPaprNotFoundError } from '../../../core/tools/paprClient.js';

/**
 * True only when the memory genuinely does not exist.
 *
 * Deliberately narrow: this is the single condition under which an update
 * may fall back to `add`. Treating any error as "missing" is what turns a
 * transient 5xx into a duplicate document.
 *
 * Checks the SDK error class first, then a raw status code — the update path
 * can surface either depending on where the failure originates.
 */
export function isMemoryNotFound(error: unknown): boolean {
  if (isPaprNotFoundError(error)) {
    return true;
  }
  const status = (error as { status?: number; statusCode?: number } | null)?.status
    ?? (error as { statusCode?: number } | null)?.statusCode;
  return status === 404;
}

export type CodeSummaryMemoryKind = 'code_file_summary' | 'code_project_overview';

function extractMemoryId(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') {
    return undefined;
  }

  const record = response as Record<string, unknown>;
  if (typeof record.id === 'string') {
    return record.id;
  }

  if (record.data && typeof record.data === 'object') {
    const data = record.data as Record<string, unknown>;
    if (typeof data.id === 'string') {
      return data.id;
    }
    if (typeof data.memory_id === 'string') {
      return data.memory_id;
    }
  }

  return undefined;
}

export class CodeSummaryMemoryStore {
  constructor(
    private client: Papr,
    private schemaId: string,
  ) {}

  async upsertFileSummary(input: {
    content: string;
    filePath: string;
    fileName: string;
    projectId: string;
    projectType: 'mini_app' | 'job';
    language: string;
    contentHash: string;
    previousMemoryId?: string;
  }): Promise<string | undefined> {
    return this.upsertSummary({
      content: input.content,
      memoryKind: 'code_file_summary',
      entityType: 'file_summary',
      previousMemoryId: input.previousMemoryId,
      customMetadata: {
        file_path: input.filePath,
        file_name: input.fileName,
        project_id: input.projectId,
        project_type: input.projectType,
        language: input.language,
        content_hash: input.contentHash,
        source: 'code_indexer',
        memory_kind: 'code_file_summary',
        entity_type: 'file_summary',
        indexed_at: new Date().toISOString(),
      },
    });
  }

  async upsertProjectOverview(input: {
    content: string;
    projectId: string;
    projectType: 'mini_app' | 'job';
    projectName: string;
    fileCount: number;
    previousMemoryId?: string;
  }): Promise<string | undefined> {
    return this.upsertSummary({
      content: input.content,
      memoryKind: 'code_project_overview',
      entityType: 'project_overview',
      previousMemoryId: input.previousMemoryId,
      customMetadata: {
        project_id: input.projectId,
        project_type: input.projectType,
        name: input.projectName,
        file_count: input.fileCount,
        source: 'code_indexer',
        memory_kind: 'code_project_overview',
        entity_type: 'project_overview',
        indexed_at: new Date().toISOString(),
      },
    });
  }

  private async upsertSummary(input: {
    content: string;
    memoryKind: CodeSummaryMemoryKind;
    entityType: string;
    previousMemoryId?: string;
    customMetadata: Record<string, string | number | boolean>;
  }): Promise<string | undefined> {
    const metadata = {
      role: 'assistant' as const,
      category: 'fact' as const,
      customMetadata: input.customMetadata,
    };

    // UPDATE IN PLACE when we already own a memory id.
    //
    // This used to be delete-then-add, which duplicates on the unhappy path:
    // the delete error was caught and logged, then `add` ran anyway, leaving
    // the old memory AND a new one. Because the server derives memoryId from
    // content, both documents carry the SAME memoryId — and every dedup in
    // the search pipeline dedups *ids*, so one logical memory then occupies
    // N result slots. Measured live: a single memoryId returned 25 times,
    // filling max_memories entirely and crowding out every other candidate.
    //
    // `memory.update()` is atomic from the reader's perspective: no window
    // where the summary is missing, and no way to end up with two documents.
    if (input.previousMemoryId) {
      try {
        await this.client.memory.update(input.previousMemoryId, {
          content: input.content,
          metadata,
        });
        return input.previousMemoryId;
      } catch (error) {
        // 404 is the ONLY case where falling back to `add` is correct — the
        // memory we were tracking is genuinely gone (deleted elsewhere, or a
        // stale tracker row). Any other failure (5xx, network, auth) must
        // propagate: retrying as `add` is exactly what created duplicates.
        if (!isMemoryNotFound(error)) {
          throw error;
        }
        console.warn(
          `[CodeSummaryMemoryStore] ${input.memoryKind} memory ${input.previousMemoryId} ` +
            `not found (404) — recreating.`,
        );
      }
    }

    const memoryScope = await paprMemoryScopeSpread({
      addPolicy: buildCodeIndexAddPolicy(this.schemaId),
    });

    const response = await this.client.memory.add({
      content: input.content,
      ...memoryScope,
      metadata,
    });

    return extractMemoryId(response);
  }
}
