/**
 * Smart Code Index Manager
 * 
 * Orchestrates code indexing with:
 * - Initial indexing on startup (only new/changed files)
 * - File watching with 5-second debounce
 * - Batch processing for efficiency
 * - Hash-based change detection
 */

import { Papr } from '@papr/memory';
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { CodeIndexerService } from './CodeIndexerService.js';
import { CodeIndexTracker } from './CodeIndexTracker.js';
import { CodeFileWatcher } from './CodeFileWatcher.js';
import { CodeSummaryIndexPipeline } from './CodeSummaryIndexPipeline.js';
import {
  getProjectPathInfo,
  isIndexableCodePath,
  isPermanentIndexError,
} from './codeIndexPaths.js';
import * as path from 'path';
import * as fs from 'fs';
import { resolvePaprUserDataPath } from '../../../core/utils/paprWorkspace.js';
import { reportPaprQuotaError } from '../../../core/utils/paprQuota.js';

/**
 * Max transient failures per file before it is dropped from the index queue.
 * Prevents a single unparseable file from looping the batch scheduler forever.
 */
const MAX_INDEX_ATTEMPTS = 3;

export interface IndexManagerConfig {
  paprDir?: string;
  dataDir?: string;
  schemaId: string;
  debounceMs?: number;
  batchSize?: number;
}

export class SmartCodeIndexManager {
  private config: Required<IndexManagerConfig>;
  private tracker: CodeIndexTracker;
  private indexer: CodeIndexerService;
  private watcher: CodeFileWatcher;
  private summaryPipeline: CodeSummaryIndexPipeline;
  
  private debounceTimer: NodeJS.Timeout | null = null;
  private batchTimer: NodeJS.Timeout | null = null;
  private queueInterval: NodeJS.Timeout | null = null;
  private isIndexing: boolean = false;
  private rateLimitHit: boolean = false;
  private stopped = false;
  
  constructor(client: Papr, config: IndexManagerConfig) {
    this.config = {
      paprDir: config.paprDir || getPaprRoot(),
      dataDir: config.dataDir || resolvePaprUserDataPath(),
      schemaId: config.schemaId,
      debounceMs: config.debounceMs || 5000, // 5 seconds
      batchSize: config.batchSize || 50
    };
    
    this.tracker = new CodeIndexTracker(this.config.dataDir);
    this.indexer = new CodeIndexerService(client, this.config.schemaId, this.config.paprDir);
    this.watcher = new CodeFileWatcher(client, this.config.schemaId, this.config.paprDir);
    this.summaryPipeline = new CodeSummaryIndexPipeline(
      client,
      this.config.schemaId,
      this.tracker,
      this.config.paprDir,
    );
  }

  getTracker(): CodeIndexTracker {
    return this.tracker;
  }
  
  /**
   * Start the index manager
   * 1. Initial index (only new/changed files)
   * 2. Start file watcher
   * 3. Process queue continuously
   */
  async start(): Promise<void> {
    console.log('🚀 Starting Smart Code Index Manager...');
    
    // Initial indexing on startup
    await this.initialIndex();
    
    // Start file watcher
    this.startFileWatcher();
    
    // Process queue continuously
    this.startQueueProcessor();
    
    console.log('✅ Smart Code Index Manager started');
  }
  
  /**
   * Stop the index manager
   */
  stop(): void {
    void this.stopAsync();
  }

  async stopAsync(): Promise<void> {
    if (this.stopped) {
      return;
    }

    console.log('🛑 Stopping Smart Code Index Manager...');
    this.stopped = true;
    
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.queueInterval) {
      clearInterval(this.queueInterval);
      this.queueInterval = null;
    }
    
    this.watcher.stop();

    // Wait for in-flight batch before closing the tracker DB (bounded wait)
    const deadline = Date.now() + 5000;
    while (this.isIndexing && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.isIndexing) {
      console.warn("[SmartCodeIndexManager] Batch still running after 5s — closing tracker anyway");
    }

    if (!this.tracker.isClosed()) {
      this.tracker.close();
    }
    
    console.log('✅ Smart Code Index Manager stopped');
  }
  
  /**
   * Initial indexing - only new/changed files
   */
  private async initialIndex(): Promise<void> {
    console.log('\n📚 Running initial index check...');
    
    const stats = this.tracker.getStats();
    console.log(`   Current: ${stats.total_files} files indexed, ${stats.queue_size} queued`);
    
    this.purgeInvalidQueuedFiles();

    // Scan filesystem for all code files
    const allFiles = this.scanAllFiles();
    console.log(`   Found: ${allFiles.length} total code files`);
    
    // Queue files that need indexing
    let newFiles = 0;
    let changedFiles = 0;
    
    for (const filePath of allFiles) {
      try {
        if (this.tracker.needsIndexing(filePath)) {
          const isNew = !fs.existsSync(filePath); // Simplified check
          this.tracker.queueFile(filePath, isNew ? 1 : 0);
          if (isNew) newFiles++;
          else changedFiles++;
        }
      } catch (error) {
        console.error(`   ⚠️  Error checking ${filePath}:`, (error as Error).message);
      }
    }
    
    const queueSize = this.tracker.getQueueSize();
    console.log(`   Queued: ${queueSize} files (${newFiles} new, ${changedFiles} changed)`);
    
    if (queueSize > 0) {
      console.log('   ⏳ Files will be indexed in the background...');
    } else {
      console.log('   ✅ All files already indexed');
    }
  }
  
  /**
   * Scan filesystem for all code files inside project directories only.
   */
  private scanAllFiles(): string[] {
    const files: string[] = [];
    const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py'];
    const excludeDirs = [
      'node_modules', '.venv', 'venv', '.git', 'dist', 'build', 'data',
      '__pycache__', '.next', '.nuxt', 'papr_repo'
    ];

    const scanProjectTree = (dir: string): void => {
      if (!fs.existsSync(dir)) return;

      for (const entry of fs.readdirSync(dir)) {
        if (excludeDirs.includes(entry) || entry.includes('_repo')) {
          continue;
        }

        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          scanProjectTree(fullPath);
        } else if (stat.isFile()) {
          const ext = path.extname(entry);
          if (codeExtensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    };

    for (const container of ['apps', 'Jobs'] as const) {
      const containerPath = path.join(this.config.paprDir, container);
      if (!fs.existsSync(containerPath)) continue;

      for (const entry of fs.readdirSync(containerPath)) {
        const projectPath = path.join(containerPath, entry);
        try {
          if (fs.statSync(projectPath).isDirectory()) {
            scanProjectTree(projectPath);
          }
        } catch {
          // Skip unreadable entries
        }
      }
    }

    return files;
  }

  /**
   * Remove queued files that cannot be indexed (e.g. loose files in Jobs/ root).
   */
  private purgeInvalidQueuedFiles(): void {
    const queuedFiles = this.tracker.getQueuedFiles(Number.MAX_SAFE_INTEGER);
    let removed = 0;

    for (const queuedFile of queuedFiles) {
      if (!isIndexableCodePath(queuedFile.file_path, this.config.paprDir)) {
        this.tracker.dequeueFile(queuedFile.file_path);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`   🧹 Removed ${removed} unindexable file(s) from queue`);
    }
  }
  
  /**
   * Start file watcher with debounced indexing
   */
  private startFileWatcher(): void {
    console.log('👀 Starting file watcher for real-time indexing...');
    
    this.watcher.setOnFileChange((filePath) => {
      this.queueFileChange(filePath);
    });

    this.watcher.setOnFileDelete((filePath) => {
      void this.summaryPipeline.processDeletedFile(filePath);
    });
    
    // Start watching
    this.watcher.start();
    
    console.log('✅ File watcher active - changes will trigger re-indexing');
  }
  
  /**
   * Queue a file change (called by file watcher)
   */
  queueFileChange(filePath: string): void {
    if (this.stopped) {
      return;
    }

    if (!isIndexableCodePath(filePath, this.config.paprDir)) {
      console.log(`   ⚠️  Skipped unindexable path: ${path.relative(this.config.paprDir, filePath)}`);
      return;
    }

    this.tracker.queueFile(filePath, 0);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.scheduleBatch(0);
    }, this.config.debounceMs);
  }

  /**
   * Schedule a single batch run. Only one timer is active at a time.
   */
  private scheduleBatch(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    if (this.batchTimer) {
      return;
    }

    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.runBatch();
    }, delayMs);
  }

  /**
   * Run batch indexing
   */
  private async runBatch(): Promise<void> {
    if (this.stopped || this.rateLimitHit) {
      return;
    }

    if (this.isIndexing) {
      this.scheduleBatch(5000);
      return;
    }

    const queueSize = this.tracker.getQueueSize();
    if (queueSize === 0) {
      return;
    }

    console.log(`\n🔄 Processing batch: ${queueSize} files queued`);
    this.isIndexing = true;

    try {
      await this.processBatch();
    } catch (error) {
      console.error('❌ Batch processing error:', error);
    } finally {
      if (!this.stopped) {
        try {
          await this.summaryPipeline.flushPendingProjectOverviews();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[CodeSummary] Project overview flush failed: ${message}`);
        }
      }

      this.isIndexing = false;

      if (!this.stopped && !this.rateLimitHit && this.tracker.getQueueSize() > 0) {
        this.scheduleBatch(1000);
      }
    }
  }
  
  /**
   * Process a batch of queued files
   */
  private async processBatch(): Promise<void> {
    const files = this.tracker.getQueuedFiles(this.config.batchSize);
    let hitRateLimit = false;
    
    for (const queuedFile of files) {
      if (this.stopped) {
        return;
      }

      try {
        if (!fs.existsSync(queuedFile.file_path)) {
          console.log(`   ⚠️  Skipped (deleted): ${queuedFile.file_path}`);
          await this.summaryPipeline.processDeletedFile(queuedFile.file_path);
          this.tracker.dequeueFile(queuedFile.file_path);
          continue;
        }

        if (!isIndexableCodePath(queuedFile.file_path, this.config.paprDir)) {
          console.log(`   ⚠️  Skipped (not in project folder): ${queuedFile.file_path}`);
          this.tracker.dequeueFile(queuedFile.file_path);
          continue;
        }
        
        // Re-check if still needs indexing (may have been indexed by another process)
        if (!this.tracker.needsIndexing(queuedFile.file_path)) {
          console.log(`   ⏭️  Skipped (unchanged): ${path.basename(queuedFile.file_path)}`);
          this.tracker.dequeueFile(queuedFile.file_path);
          continue;
        }
        
        // Index the file
        await this.indexSingleFile(queuedFile.file_path);
        
        // Remove from queue
        this.tracker.dequeueFile(queuedFile.file_path);
        
        console.log(`   ✅ Indexed: ${path.basename(queuedFile.file_path)}`);
        
        // Add delay between files to avoid rate limiting (200ms)
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        const err = error as Error;
        
        // Check if it's a rate limit or service error from PAPR Memory
        const isRateLimitError = error instanceof Papr.RateLimitError || 
                                  error instanceof Papr.PermissionDeniedError ||
                                  err.message.includes('403') || 
                                  err.message.includes('503') || // Service unavailable (often rate limiting)
                                  err.message.includes('429') || // Too many requests
                                  err.message.includes('limit') ||
                                  err.message.includes('quota');
        
        if (isRateLimitError) {
          reportPaprQuotaError(error, "code-index");
          // Extract the actual error message from PAPR API
          let errorMessage = err.message;
          if (error instanceof Papr.RateLimitError) {
            // PAPR returns upgrade message in the error body
            errorMessage = err.message;
          }
          
          console.error(`   ❌ Failed to index ${queuedFile.file_path}: ${errorMessage}`);
          console.error('   💡 PAPR Memory returned a transient service error (503/429).');
          console.error('   💡 File kept in queue — will retry after 30-second cooldown.');
          console.error('   💡 If persistent, check https://memory.papr.ai/health or platform settings.');

          // Keep file in queue so the cooldown retry can pick it up again
          hitRateLimit = true;
          break; // Stop processing batch entirely
        } else if (isPermanentIndexError(err.message)) {
          console.error(`   ❌ Failed to index ${queuedFile.file_path}: ${err.message}`);
          console.error('   ⚠️  Removing from queue (permanent error)');
          this.tracker.dequeueFile(queuedFile.file_path);
        } else {
          // Transient error: keep in queue, but bound the retries. Without a
          // cap, a file that always fails (e.g. malformed JSON from the summary
          // model) is retried every second forever, flooding logs and starving
          // the rest of the queue.
          const attempts = this.tracker.recordQueueFailure(
            queuedFile.file_path,
            err.message,
          );

          if (attempts >= MAX_INDEX_ATTEMPTS) {
            console.error(
              `   ❌ Failed to index ${queuedFile.file_path}: ${err.message}`,
            );
            console.error(
              `   ⚠️  Giving up after ${attempts} attempts — removing from queue.`,
            );
            this.tracker.dequeueFile(queuedFile.file_path);
          } else {
            console.error(
              `   ❌ Failed to index ${queuedFile.file_path} ` +
                `(attempt ${attempts}/${MAX_INDEX_ATTEMPTS}): ${err.message}`,
            );
          }
        }
      }
    }
    
    // If we hit rate limit, schedule retry in 30 seconds instead of pausing forever
    if (hitRateLimit) {
      this.rateLimitHit = true;
      const remaining = this.tracker.getQueueSize();
      if (remaining > 0) {
        console.log(`\n   ⏸️  Indexing paused - PAPR Memory returned transient errors.`);
        console.log(`   💡 ${remaining} files remain in queue (including the failed file).`);
        console.log(`   💡 Retrying in 30 seconds.\n`);
        
        setTimeout(() => {
          console.log('\n🔄 Retrying indexing after 30-second cooldown...');
          this.rateLimitHit = false;
          this.scheduleBatch(0);
        }, 30000);
      }
    }
  }
  
  /**
   * Index a single file
   */
  private async indexSingleFile(filePath: string): Promise<void> {
    const hash = this.tracker.calculateFileHash(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    
    const projectInfo = getProjectPathInfo(filePath, this.config.paprDir);
    if (!projectInfo) {
      throw new Error('File is not indexable — must be inside apps/{id}/ or Jobs/{id}/');
    }

    try {
      await this.summaryPipeline.processChangedFile(filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodeSummary] File summary failed for ${path.basename(filePath)}: ${message}`);
    }

    await this.indexer.indexSingleCodeFile(filePath);
    
    // Record in tracker after successful API indexing
    this.tracker.recordIndexedFile({
      file_path: filePath,
      content_hash: hash,
      last_indexed_at: new Date(),
      schema_version: this.config.schemaId,
      project_id: projectInfo.projectId,
      lines_of_code: content.split('\n').length,
      language: this.detectLanguage(path.extname(filePath))
    });
  }
  
  /**
   * Detect language from file extension
   */
  private detectLanguage(ext: string): string {
    const map: Record<string, string> = {
      '.ts': 'TypeScript',
      '.tsx': 'TypeScript',
      '.js': 'JavaScript',
      '.jsx': 'JavaScript',
      '.py': 'Python'
    };
    return map[ext] || 'Unknown';
  }
  
  /**
   * Start continuous queue processor
   */
  private startQueueProcessor(): void {
    // Check queue every 10 seconds
    const checkQueue = () => {
      if (this.stopped) {
        return;
      }
      if (this.tracker.getQueueSize() > 0) {
        this.scheduleBatch(0);
      }
    };

    this.queueInterval = setInterval(checkQueue, 10000);

    if (this.tracker.getQueueSize() > 0) {
      this.scheduleBatch(0);
    }
  }
  
  /**
   * Get current indexing status
   */
  getStatus(): {
    is_indexing: boolean;
    stats: {
      total_files: number;
      total_projects: number;
      queue_size: number;
      last_indexed_at?: Date;
    };
  } {
    return {
      is_indexing: this.isIndexing,
      stats: this.tracker.getStats()
    };
  }
}
