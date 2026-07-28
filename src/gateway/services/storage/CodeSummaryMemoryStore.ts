/**
 * Persists code summaries to Papr Memory with upsert semantics.
 */

import { Papr } from '@papr/memory';
import { buildCodeIndexAddPolicy } from '../../utils/paprMemoryPolicy.js';
import { paprMemoryScopeSpread } from '../../utils/memoryScopeResolver.js';

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
    if (input.previousMemoryId) {
      try {
        await this.client.memory.delete(input.previousMemoryId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[CodeSummaryMemoryStore] Failed to delete old ${input.memoryKind} memory ${input.previousMemoryId}: ${message}`,
        );
      }
    }

    const memoryScope = await paprMemoryScopeSpread({
      addPolicy: buildCodeIndexAddPolicy(this.schemaId),
    });

    const response = await this.client.memory.add({
      content: input.content,
      ...memoryScope,
      metadata: {
        role: 'assistant',
        category: 'fact',
        customMetadata: input.customMetadata,
      },
    });

    return extractMemoryId(response);
  }
}
