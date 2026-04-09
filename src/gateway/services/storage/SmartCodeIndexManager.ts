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
import { CodeIndexerService } from './CodeIndexerService.js';
import { CodeIndexTracker } from './CodeIndexTracker.js';
import { CodeFileWatcher } from './CodeFileWatcher.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

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
  
  private debounceTimer: NodeJS.Timeout | null = null;
  private isIndexing: boolean = false;
  private rateLimitHit: boolean = false;
  
  constructor(client: Papr, config: IndexManagerConfig) {
    this.config = {
      paprDir: config.paprDir || path.join(os.homedir(), 'Papr'),
      dataDir: config.dataDir || path.join(os.homedir(), '.paprwork-v2'),
      schemaId: config.schemaId,
      debounceMs: config.debounceMs || 5000, // 5 seconds
      batchSize: config.batchSize || 50
    };
    
    this.tracker = new CodeIndexTracker(this.config.dataDir);
    this.indexer = new CodeIndexerService(client, this.config.schemaId, this.config.paprDir);
    this.watcher = new CodeFileWatcher(client, this.config.schemaId, this.config.paprDir);
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
    console.log('🛑 Stopping Smart Code Index Manager...');
    
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    this.watcher.stop();
    this.tracker.close();
    
    console.log('✅ Smart Code Index Manager stopped');
  }
  
  /**
   * Initial indexing - only new/changed files
   */
  private async initialIndex(): Promise<void> {
    console.log('\n📚 Running initial index check...');
    
    const stats = this.tracker.getStats();
    console.log(`   Current: ${stats.total_files} files indexed, ${stats.queue_size} queued`);
    
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
   * Scan filesystem for all code files
   */
  private scanAllFiles(): string[] {
    const files: string[] = [];
    const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py'];
    
    // Load excluded folders from settings (will be done dynamically in real implementation)
    // For now, use the default list + any folder containing "repo" in the name
    const excludeDirs = [
      'node_modules', '.venv', 'venv', '.git', 'dist', 'build', 'data',
      '__pycache__', '.next', '.nuxt', 'papr_repo'
    ];
    
    const scanDir = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        // Skip excluded folders
        if (excludeDirs.includes(entry) || entry.includes('_repo')) {
          continue;
        }
        
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          scanDir(fullPath);
        } else if (stat.isFile()) {
          const ext = path.extname(entry);
          if (codeExtensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    };
    
    scanDir(path.join(this.config.paprDir, 'apps'));
    scanDir(path.join(this.config.paprDir, 'Jobs'));
    
    return files;
  }
  
  /**
   * Start file watcher with debounced indexing
   */
  private startFileWatcher(): void {
    console.log('👀 Starting file watcher for real-time indexing...');
    
    // Connect watcher to queue changes
    this.watcher.setOnFileChange((filePath) => {
      this.queueFileChange(filePath);
    });
    
    // Start watching
    this.watcher.start();
    
    console.log('✅ File watcher active - changes will trigger re-indexing');
  }
  
  /**
   * Queue a file change (called by file watcher)
   */
  queueFileChange(filePath: string): void {
    // Add to queue
    this.tracker.queueFile(filePath, 0);
    
    // Debounce: reset 5-second timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    this.debounceTimer = setTimeout(() => {
      this.triggerBatchIndex();
    }, this.config.debounceMs);
  }
  
  /**
   * Trigger batch indexing
   */
  private async triggerBatchIndex(): Promise<void> {
    if (this.rateLimitHit) {
      console.log('   🛑 Indexing paused - PAPR Memory quota exceeded.');
      console.log('   💡 Please upgrade your account at: https://platform.papr.ai/settings');
      console.log('   💡 Restart the app after upgrading to resume indexing.');
      return;
    }
    
    if (this.isIndexing) {
      console.log('   ⏸️  Already indexing, will retry in 5s...');
      setTimeout(() => this.triggerBatchIndex(), 5000);
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
      this.isIndexing = false;
      
      // Only schedule next batch if we haven't hit rate limit
      if (!this.rateLimitHit && this.tracker.getQueueSize() > 0) {
        setTimeout(() => this.triggerBatchIndex(), 1000);
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
      try {
        // Skip if file no longer exists
        if (!fs.existsSync(queuedFile.file_path)) {
          console.log(`   ⚠️  Skipped (deleted): ${queuedFile.file_path}`);
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
          // Extract the actual error message from PAPR API
          let errorMessage = err.message;
          if (error instanceof Papr.RateLimitError) {
            // PAPR returns upgrade message in the error body
            errorMessage = err.message;
          }
          
          console.error(`   ❌ Failed to index ${queuedFile.file_path}: ${errorMessage}`);
          console.error('   💡 PAPR Memory service issue (503) or quota exceeded.');
          console.error('   💡 This may be temporary rate limiting - will retry in 30 seconds.');
          console.error('   💡 If persistent, upgrade at: https://platform.papr.ai/settings');
          
          // Remove from queue on rate limit - don't retry immediately
          this.tracker.dequeueFile(queuedFile.file_path);
          hitRateLimit = true;
          break; // Stop processing batch entirely
        } else {
          console.error(`   ❌ Failed to index ${queuedFile.file_path}: ${err.message}`);
          // Keep in queue for retry on other errors
        }
      }
    }
    
    // If we hit rate limit, schedule retry in 30 seconds instead of pausing forever
    if (hitRateLimit) {
      this.rateLimitHit = true;
      const remaining = this.tracker.getQueueSize();
      if (remaining > 0) {
        console.log(`\n   ⏸️  Indexing paused - PAPR Memory returned 503 errors.`);
        console.log(`   💡 ${remaining} files remain in queue.`);
        console.log(`   💡 This may be temporary rate limiting - will retry in 30 seconds.`);
        console.log(`   💡 If errors persist, check https://platform.papr.ai/settings for quota.\n`);
        
        // Schedule retry in 30 seconds
        setTimeout(() => {
          console.log('\n🔄 Retrying indexing after 30-second cooldown...');
          this.rateLimitHit = false;
          this.triggerBatchIndex();
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
    
    // Determine project ID from path
    const projectId = this.extractProjectId(filePath);
    if (!projectId) {
      throw new Error('Could not determine project ID');
    }
    
    // Use CodeIndexerService to actually index to PAPR Memory API
    const isJob = filePath.includes('/Jobs/');
    const isMiniApp = filePath.includes('/apps/');
    
    if (isJob) {
      await this.indexer.indexSingleJob(projectId);
    } else if (isMiniApp) {
      await this.indexer.indexSingleMiniApp(projectId);
    } else {
      throw new Error('File not in Jobs or apps folder');
    }
    
    // Record in tracker after successful API indexing
    this.tracker.recordIndexedFile({
      file_path: filePath,
      content_hash: hash,
      last_indexed_at: new Date(),
      schema_version: this.config.schemaId,
      project_id: projectId,
      lines_of_code: content.split('\n').length,
      language: this.detectLanguage(path.extname(filePath))
    });
  }
  
  /**
   * Extract project ID from file path
   */
  private extractProjectId(filePath: string): string | null {
    const parts = filePath.split(path.sep);
    const appsIndex = parts.indexOf('apps');
    const jobsIndex = parts.indexOf('Jobs');
    
    if (appsIndex >= 0 && appsIndex < parts.length - 1) {
      return parts[appsIndex + 1];
    }
    if (jobsIndex >= 0 && jobsIndex < parts.length - 1) {
      return parts[jobsIndex + 1];
    }
    
    return null;
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
      if (!this.isIndexing && this.tracker.getQueueSize() > 0) {
        this.triggerBatchIndex();
      }
    };
    
    setInterval(checkQueue, 10000);
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
