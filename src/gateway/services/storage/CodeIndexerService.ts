/**
 * Code Indexer Service
 * 
 * Scans ~/Papr folder for mini-apps and jobs, extracts metadata,
 * and uploads to Papr Memory Cloud with the code schema.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { normalizeForDedupe } from '../../../core/utils/resultSetShape.js';
import { getPaprRoot } from '../../../core/utils/paprRoot.js';
import { Papr } from '@papr/memory';
import { buildCodeIndexAddPolicy } from '../../utils/paprMemoryPolicy.js';
import { paprMemoryScopeSpread } from '../../utils/memoryScopeResolver.js';
import { getProjectPathInfo } from './codeIndexPaths.js';
import { reserveMemoryWrite } from '../memoryWriteGuard.js';
import {
  isRawCodeMemoryIndexEnabled,
  announceRawCodeIndexPolicyOnce,
} from './codeIndexPolicy.js';
import type { CodeIndexTracker } from './CodeIndexTracker.js';
import { isMemoryNotFound } from './CodeSummaryMemoryStore.js';
import { resolveMiniAppDisplayName } from './codeIndexMetadata.js';
import { parseJsonTolerant } from '../../../core/utils/atomicJsonWrite.js';

/** Short content digest for duplicate detection. Not security-sensitive. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

interface JobJsonMetadata {
  id?: string;
  name?: string;
  type?: "python" | "node" | "subagent";
  status?: string;
  folder?: string;
  command?: string;
  retries?: { maxAttempts?: number };
  maxAttempts?: number;
  retentionDays?: number;
  outputMode?: string;
  memoryPolicy?: string;
  maxTurns?: number;
  exitCode?: number;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
  dependsOn?: Array<{ jobId: string; onStatus?: string }>;
}

export interface CodeFileMetadata {
  file_path: string;
  file_name: string;
  language: string;
  lines_of_code: number;
  last_modified: Date;
  data_source_path?: string;
}

export interface DataSource {
  id: string;
  type: string;
  jobId?: string;
  alias: string;
  dbPath: string;
  tables: string[];
  linkedAt: string;
}

export interface ProjectMetadata {
  project_id: string;
  name: string;
  type: 'mini_app' | 'job';
  
  // Job-specific
  job_type?: 'python' | 'node' | 'subagent';
  status?: string;
  folder?: string;
  command?: string;
  max_attempts?: number;
  retention_days?: number;
  output_mode?: string;
  memory_policy?: string;
  max_turns?: number;
  last_run_at?: Date;
  exit_code?: number;
  
  // Data sources
  data_sources?: DataSource[];
  
  // Timestamps
  created_at?: Date;
  updated_at?: Date;
  
  // Dependencies
  dependencies?: Array<{
    jobId: string;
    onStatus: string;
  }>;
}

export class CodeIndexerService {
  private paprDir: string;
  private schemaId: string;
  
  constructor(
    private client: Papr,
    schemaId: string,
    paprDir?: string,
    /**
     * Optional so existing call sites keep working. When supplied, raw code
     * files are UPDATED in place on re-index instead of re-added — without it
     * every re-index inserts another Memory document sharing one memoryId.
     */
    private tracker?: CodeIndexTracker,
  ) {
    this.paprDir = paprDir || getPaprRoot();
    this.schemaId = schemaId;
  }

  
  /**
   * Index all code from ~/Papr folder
   */
  async indexAllCode(): Promise<{
    projects: number;
    files: number;
    errors: string[];
  }> {
    console.log('🔍 Scanning ~/Papr for code...');
    console.log(`   Base directory: ${this.paprDir}`);
    
    const stats = {
      projects: 0,
      files: 0,
      errors: [] as string[]
    };
    
    // Index mini-apps
    const appsDir = path.join(this.paprDir, 'apps');
    if (fs.existsSync(appsDir)) {
      const appStats = await this.indexMiniApps(appsDir);
      stats.projects += appStats.projects;
      stats.files += appStats.files;
      stats.errors.push(...appStats.errors);
    } else {
      console.log('⚠️  Apps directory not found');
    }
    
    // Index jobs
    const jobsDir = path.join(this.paprDir, 'Jobs');
    if (fs.existsSync(jobsDir)) {
      const jobStats = await this.indexJobs(jobsDir);
      stats.projects += jobStats.projects;
      stats.files += jobStats.files;
      stats.errors.push(...jobStats.errors);
    } else {
      console.log('⚠️  Jobs directory not found');
    }
    
    console.log(`\n✅ Indexing complete:`);
    console.log(`   Projects: ${stats.projects}`);
    console.log(`   Files: ${stats.files}`);
    if (stats.errors.length > 0) {
      console.log(`   Errors: ${stats.errors.length}`);
    }
    
    return stats;
  }
  
  /**
   * Index one code file to PAPR (used by incremental queue processing).
   */
  async indexSingleCodeFile(filePath: string): Promise<void> {
    const projectInfo = getProjectPathInfo(filePath, this.paprDir);
    if (!projectInfo) {
      throw new Error(`File is not indexable — must be inside apps/{id}/ or Jobs/{id}/`);
    }

    const metadata =
      projectInfo.type === 'mini_app'
        ? await this.extractMiniAppMetadata(projectInfo.projectDir, projectInfo.projectId)
        : await this.extractJobMetadata(projectInfo.projectDir, projectInfo.projectId);

    const fileMetadata = this.extractCodeFileMetadata(filePath, metadata);
    await this.indexCodeFile(fileMetadata, metadata);
  }

  /**
   * Index a single mini-app project
   */
  async indexSingleMiniApp(appId: string): Promise<void> {
    const appPath = path.join(this.paprDir, 'apps', appId);
    if (!fs.existsSync(appPath)) {
      throw new Error(`Mini-app not found: ${appId}`);
    }
    
    const metadata = await this.extractMiniAppMetadata(appPath, appId);
    await this.indexProject(metadata);
    
    // Index code files
    const codeFiles = this.findCodeFiles(appPath);
    for (const filePath of codeFiles) {
      const fileMetadata = this.extractCodeFileMetadata(filePath, metadata);
      await this.indexCodeFile(fileMetadata, metadata);
    }
  }

  /**
   * Index a single job project
   */
  async indexSingleJob(jobId: string): Promise<void> {
    const jobPath = path.join(this.paprDir, 'Jobs', jobId);
    if (!fs.existsSync(jobPath)) {
      throw new Error(`Job not found: ${jobId}`);
    }
    
    const metadata = await this.extractJobMetadata(jobPath, jobId);
    await this.indexProject(metadata);
    
    // Index code files
    const codeFiles = this.findCodeFiles(jobPath);
    for (const filePath of codeFiles) {
      const fileMetadata = this.extractCodeFileMetadata(filePath, metadata);
      await this.indexCodeFile(fileMetadata, metadata);
    }
  }
  
  /**
   * Index all mini-apps
   */
  private async indexMiniApps(appsDir: string): Promise<{
    projects: number;
    files: number;
    errors: string[];
  }> {
    console.log('\n📱 Indexing mini-apps...');
    
    const stats = { projects: 0, files: 0, errors: [] as string[] };
    const apps = fs.readdirSync(appsDir);
    
    for (const appId of apps) {
      const appPath = path.join(appsDir, appId);
      
      if (!fs.statSync(appPath).isDirectory()) continue;
      
      try {
        // Extract project metadata
        const projectMetadata = await this.extractMiniAppMetadata(appPath, appId);
        
        // Index project
        await this.indexProject(projectMetadata);
        stats.projects++;
        
        // Find and index code files
        const codeFiles = this.findCodeFiles(appPath);
        for (const filePath of codeFiles) {
          try {
            const fileMetadata = this.extractCodeFileMetadata(filePath, projectMetadata);
            await this.indexCodeFile(fileMetadata, projectMetadata);
            stats.files++;
          } catch (error) {
            stats.errors.push(`Failed to index ${filePath}: ${(error as Error).message}`);
          }
        }
        
        console.log(`   ✓ ${projectMetadata.name} (${codeFiles.length} files)`);
      } catch (error) {
        stats.errors.push(`Failed to index app ${appId}: ${(error as Error).message}`);
      }
    }
    
    return stats;
  }
  
  /**
   * Index all jobs
   */
  private async indexJobs(jobsDir: string): Promise<{
    projects: number;
    files: number;
    errors: string[];
  }> {
    console.log('\n⚙️  Indexing jobs...');
    
    const stats = { projects: 0, files: 0, errors: [] as string[] };
    const jobs = fs.readdirSync(jobsDir);
    
    for (const jobId of jobs) {
      const jobPath = path.join(jobsDir, jobId);
      
      if (!fs.statSync(jobPath).isDirectory()) continue;
      
      try {
        // Extract project metadata from job.json
        const projectMetadata = await this.extractJobMetadata(jobPath, jobId);
        
        // Index project
        await this.indexProject(projectMetadata);
        stats.projects++;
        
        // Find and index code files
        const codeFiles = this.findCodeFiles(jobPath);
        for (const filePath of codeFiles) {
          try {
            const fileMetadata = this.extractCodeFileMetadata(filePath, projectMetadata);
            await this.indexCodeFile(fileMetadata, projectMetadata);
            stats.files++;
          } catch (error) {
            stats.errors.push(`Failed to index ${filePath}: ${(error as Error).message}`);
          }
        }
        
        console.log(`   ✓ ${projectMetadata.name} (${codeFiles.length} files)`);
      } catch (error) {
        stats.errors.push(`Failed to index job ${jobId}: ${(error as Error).message}`);
      }
    }
    
    return stats;
  }
  
  /**
   * Extract mini-app metadata
   */
  private async extractMiniAppMetadata(appPath: string, appId: string): Promise<ProjectMetadata> {
    const metadata: ProjectMetadata = {
      project_id: appId,
      name: resolveMiniAppDisplayName(appId, appPath),
      type: 'mini_app'
    };
    
    // Check for data-sources.json
    const dataSourcesPath = path.join(appPath, 'data-sources.json');
    if (fs.existsSync(dataSourcesPath)) {
      try {
        const dataSourcesContent = fs.readFileSync(dataSourcesPath, 'utf-8');
        metadata.data_sources = JSON.parse(dataSourcesContent);
      } catch (error) {
        console.warn(`   ⚠️  Failed to parse data-sources.json for ${appId}`);
      }
    }
    
    return metadata;
  }
  
  /**
   * Extract job metadata from job.json
   */
  private async extractJobMetadata(jobPath: string, jobId: string): Promise<ProjectMetadata> {
    const jobJsonPath = path.join(jobPath, 'job.json');
    
    if (!fs.existsSync(jobJsonPath)) {
      return {
        project_id: jobId,
        name: jobId,
        type: 'job'
      };
    }
    
    const jobJsonRaw = fs.readFileSync(jobJsonPath, 'utf-8');
    const jobJson = parseJsonTolerant<JobJsonMetadata>(jobJsonRaw);
    if (!jobJson) {
      return {
        project_id: jobId,
        name: jobId,
        type: 'job',
      };
    }
    
    const metadata: ProjectMetadata = {
      project_id: jobJson.id || jobId,
      name: jobJson.name || jobId,
      type: 'job',
      job_type: jobJson.type,
      status: jobJson.status,
      folder: jobJson.folder,
      command: jobJson.command,
      max_attempts: jobJson.retries?.maxAttempts || jobJson.maxAttempts,
      retention_days: jobJson.retentionDays,
      output_mode: jobJson.outputMode,
      memory_policy: jobJson.memoryPolicy,
      max_turns: jobJson.maxTurns,
      exit_code: jobJson.exitCode,
      created_at: jobJson.createdAt ? new Date(jobJson.createdAt) : undefined,
      updated_at: jobJson.updatedAt ? new Date(jobJson.updatedAt) : undefined,
      last_run_at: jobJson.lastRunAt ? new Date(jobJson.lastRunAt) : undefined
    };
    
    // Extract dependencies
    if (jobJson.dependsOn && Array.isArray(jobJson.dependsOn)) {
      metadata.dependencies = jobJson.dependsOn.map((dep: any) => ({
        jobId: dep.jobId,
        onStatus: dep.onStatus
      }));
    }
    
    // Check for data-sources.json
    const dataSourcesPath = path.join(jobPath, 'data-sources.json');
    if (fs.existsSync(dataSourcesPath)) {
      try {
        const dataSourcesContent = fs.readFileSync(dataSourcesPath, 'utf-8');
        metadata.data_sources = JSON.parse(dataSourcesContent);
      } catch (error) {
        console.warn(`   ⚠️  Failed to parse data-sources.json for ${jobId}`);
      }
    }
    
    return metadata;
  }
  
  /**
   * Find all code files in directory
   */
  private findCodeFiles(dirPath: string): string[] {
    const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py'];
    const excludeDirs = ['node_modules', '.venv', 'venv', '.git', 'dist', 'build', 'data'];
    const files: string[] = [];
    
    const traverse = (dir: string) => {
      const entries = fs.readdirSync(dir);
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          if (!excludeDirs.includes(entry)) {
            traverse(fullPath);
          }
        } else if (stat.isFile()) {
          const ext = path.extname(entry);
          if (codeExtensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    };
    
    traverse(dirPath);
    return files;
  }
  
  /**
   * Extract code file metadata
   */
  private extractCodeFileMetadata(
    filePath: string,
    projectMetadata: ProjectMetadata
  ): CodeFileMetadata {
    const content = fs.readFileSync(filePath, 'utf-8');
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath);
    
    const metadata: CodeFileMetadata = {
      file_path: filePath,
      file_name: path.basename(filePath),
      language: this.detectLanguage(ext),
      lines_of_code: content.split('\n').length,
      last_modified: stat.mtime
    };
    
    // Check if file accesses data sources
    if (projectMetadata.data_sources && projectMetadata.data_sources.length > 0) {
      for (const ds of projectMetadata.data_sources) {
        if (content.includes(ds.dbPath) || content.includes(ds.alias)) {
          metadata.data_source_path = ds.dbPath;
          break;
        }
      }
    }
    
    return metadata;
  }
  
  /**
   * Detect language from file extension
   */
  private detectLanguage(ext: string): string {
    const languageMap: Record<string, string> = {
      '.ts': 'TypeScript',
      '.tsx': 'TypeScript',
      '.js': 'JavaScript',
      '.jsx': 'JavaScript',
      '.py': 'Python'
    };
    
    return languageMap[ext] || 'Unknown';
  }
  
  /**
   * Index a project to PAPR
   */
  private async indexProject(metadata: ProjectMetadata): Promise<void> {
    // Same policy as indexCodeFile. This write had no gate of any kind and
    // stable content ("Project: X / Type: Y / ID: Z"), so it re-added an
    // identical row on every index pass.
    //
    // The richer replacement already exists: CodeSummaryIndexPipeline's
    // project overview, which upserts and reflects what the project DOES.
    announceRawCodeIndexPolicyOnce();
    if (!isRawCodeMemoryIndexEnabled()) {
      return;
    }

    // Create a memory entry for the project
    // Convert project metadata for PAPR (only primitives allowed in customMetadata)
    const paprMetadata: Record<string, string | number | boolean> = {
      project_id: metadata.project_id,
      name: metadata.name,
      type: metadata.type,
      source: 'code_indexer',
      indexed_at: new Date().toISOString(),
      entity_type: 'project'
    };
    
    // Add optional fields only if they exist
    if (metadata.job_type) paprMetadata.job_type = metadata.job_type;
    if (metadata.status) paprMetadata.status = metadata.status;
    if (metadata.folder) paprMetadata.folder = metadata.folder;
    if (metadata.exit_code !== undefined) paprMetadata.exit_code = metadata.exit_code;
    if (metadata.max_attempts) paprMetadata.max_attempts = metadata.max_attempts;
    if (metadata.retention_days) paprMetadata.retention_days = metadata.retention_days;
    if (metadata.max_turns) paprMetadata.max_turns = metadata.max_turns;
    if (metadata.last_run_at) paprMetadata.last_run_at = metadata.last_run_at.toISOString();
    if (metadata.created_at) paprMetadata.created_at = metadata.created_at.toISOString();
    if (metadata.updated_at) paprMetadata.updated_at = metadata.updated_at.toISOString();
    
    // Project metadata content is stable ("Project: X / Type: Y / ID: Z"), so
    // every full index pass produced another identical row. This is the same
    // defect as indexCodeFile() and had no gate of any kind.
    const projectContent = `Project: ${metadata.name}\nType: ${metadata.type}\nID: ${metadata.project_id}`;
    const reservation = reserveMemoryWrite(projectContent, 'code_indexer_project');
    if (!reservation.proceed) {
      return;
    }

    const memoryScope = await paprMemoryScopeSpread({
      addPolicy: buildCodeIndexAddPolicy(this.schemaId),
    });

    try {
      await this.client.memory.add({
        content: projectContent,
        ...memoryScope,
        metadata: {
          role: 'assistant',
          category: 'learning',
          customMetadata: paprMetadata
        },
      });
      reservation.commit();
    } catch (error) {
      reservation.release();
      throw error;
    }
  }
  
  /**
   * Index a code file to PAPR
   */
  private async indexCodeFile(
    fileMetadata: CodeFileMetadata,
    projectMetadata: ProjectMetadata
  ): Promise<void> {
    // Raw file bodies are OFF by default. See codeIndexPolicy.ts.
    //
    // This is the write that produced 29,315 duplicate code_indexer rows and
    // that the agent reads in 1.3% of searches. LLM summaries of the same
    // files still sync via CodeSummaryIndexPipeline, which is a real upsert
    // (deletes previousMemoryId before adding), so disabling this does not
    // blind code search — it removes the raw, duplicated half.
    //
    // Returning before readFileSync keeps a disabled indexer free.
    announceRawCodeIndexPolicyOnce();
    if (!isRawCodeMemoryIndexEnabled()) {
      return;
    }

    const content = fs.readFileSync(fileMetadata.file_path, 'utf-8');
    
    // Truncate very long files for indexing
    const maxContentLength = 50000; // ~50KB
    const truncatedContent = content.length > maxContentLength
      ? content.substring(0, maxContentLength) + '\n\n... (truncated)'
      : content;
    
    // Convert file metadata for PAPR (only primitives allowed in customMetadata)
    const paprMetadata: Record<string, string | number | boolean> = {
      file_path: fileMetadata.file_path,
      file_name: fileMetadata.file_name,
      language: fileMetadata.language,
      lines_of_code: fileMetadata.lines_of_code,
      last_modified: fileMetadata.last_modified.toISOString(),
      project_id: projectMetadata.project_id,
      project_name: projectMetadata.name,
      project_type: projectMetadata.type,
      source: 'code_indexer',
      indexed_at: new Date().toISOString(),
      entity_type: 'code_file',
      // Exact hash identifies re-indexes of unchanged files. `boilerplate_hash`
      // ignores UUIDs/hex/integers so generated scaffolding shares one value:
      // 98 of 110 `db.ts` files in this workspace are identical apart from
      // their APP_ID constant, which is why exact hashing alone cannot see the
      // duplication. Recorded (not filtered) so search can collapse groups
      // without the indexer having to decide which project "owns" a copy.
      content_hash: sha256(content),
      boilerplate_hash: sha256(normalizeForDedupe(content)),
    };
    
    if (fileMetadata.data_source_path) {
      paprMetadata.data_source_path = fileMetadata.data_source_path;
    }
    
    const fileMetadataForPapr = {
      role: 'assistant' as const,
      category: 'learning' as const,
      customMetadata: paprMetadata,
    };

    const rethrow = (error: unknown): never => {
      const err = error as {
        statusCode?: number;
        code?: number;
        body?: unknown;
        message?: string;
      };
      throw new Error(
        `${err.statusCode ?? err.code ?? 'Unknown'} ${JSON.stringify(err.body ?? err.message ?? error)}`,
      );
    };

    // Content-hash guard, above the update/add split. `needsIndexing()` gates
    // the two QUEUE paths (SmartCodeIndexManager:169, :393) but not the four
    // direct call sites — full re-index and single-project index reach
    // indexCodeFile() with no gate at all, so every full pass re-wrote every
    // file. It also catches what no per-path check can: measured group
    // 05a6d704 is render.ts AND drawer.ts with byte-identical content, so two
    // paths share one memoryId. Identical bytes need neither an add nor an
    // update, which is why this sits above both rather than beside them.
    const reservation = reserveMemoryWrite(truncatedContent, 'code_indexer');
    if (!reservation.proceed) {
      return;
    }

    try {
      // UPDATE IN PLACE on re-index.
      //
      // This path was an unconditional `memory.add()`, so every re-index of a
      // file inserted ANOTHER Memory document. Because the server derives
      // memoryId from content, those documents all share one memoryId, and the
      // search pipeline dedups ids rather than documents — so a single logical
      // memory expands to fill every result slot. Measured live: one memoryId
      // returned 25/25 times across 16 distinct file_paths, with 25 distinct
      // created_at values proving 25 separate inserts.
      //
      // The content guard cannot stand in for this: changed content hashes
      // differently, so it proceeds, and proceeding without an update means an
      // insert.
      const knownMemoryId = this.tracker?.getIndexedFileMemoryId(
        fileMetadata.file_path,
      );
      if (knownMemoryId) {
        try {
          await this.client.memory.update(knownMemoryId, {
            content: truncatedContent,
            metadata: fileMetadataForPapr,
          });
          reservation.commit();
          return;
        } catch (error) {
          // Only a genuine 404 may fall through to `add`. Retrying any other
          // failure as an insert is precisely what produced the duplicates.
          if (!isMemoryNotFound(error)) {
            rethrow(error);
          }
          console.warn(
            `[CodeIndexer] memory ${knownMemoryId} for ${fileMetadata.file_name} ` +
              `not found (404) — recreating.`,
          );
        }
      }

      const fileMemoryScope = await paprMemoryScopeSpread({
        addPolicy: buildCodeIndexAddPolicy(this.schemaId),
      });

      const response = await this.client.memory.add({
        content: truncatedContent,
        ...fileMemoryScope,
        metadata: fileMetadataForPapr,
      }).catch(rethrow);

      reservation.commit();

      // Persist the id so the NEXT run updates instead of inserting. Without
      // this the column stays NULL and the duplication repeats indefinitely.
      const newMemoryId = extractAddedMemoryId(response);
      if (newMemoryId && this.tracker) {
        this.tracker.setIndexedFileMemoryId(fileMetadata.file_path, newMemoryId);
      }
    } catch (error) {
      // Release so a retry is not blocked by our own reservation.
      reservation.release();
      throw error;
    }
  }
}

/** Read the memory id out of an `add` response across known payload shapes. */
function extractAddedMemoryId(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const record = response as Record<string, unknown>;
  if (typeof record.id === 'string') return record.id;

  const data = record.data;
  if (Array.isArray(data)) {
    const first = data[0] as Record<string, unknown> | undefined;
    const id = first?.memoryId ?? first?.memory_id ?? first?.id;
    return typeof id === 'string' ? id : undefined;
  }
  if (data && typeof data === 'object') {
    const inner = data as Record<string, unknown>;
    const id = inner.id ?? inner.memory_id ?? inner.memoryId;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}
