/**
 * Code File Watcher
 * 
 * Watches ~/Papr folder for code changes and auto-reindexes.
 */

import { TreeWatcher } from '../TreeWatcher.js';
import * as path from 'path';
import { getPaprRoot } from '../../../core/utils/paprRoot.js';
import { Papr } from '@papr/memory';
import { isIndexableCodePath } from './codeIndexPaths.js';
// import { CodeIndexerService } from './CodeIndexerService.js';

export class CodeFileWatcher {
  private watcher: TreeWatcher | null = null;
  private paprDir: string;
  private onFileChange?: (filePath: string) => void;
  private onFileDelete?: (filePath: string) => void;
  
  constructor(
    _client: Papr,
    _schemaId: string,
    paprDir?: string
  ) {
    this.paprDir = paprDir || getPaprRoot();
    // Store for future use in re-indexing
    // this.client = _client;
    // this.schemaId = _schemaId;
  }
  
  /**
   * Set callback for file changes
   */
  setOnFileChange(callback: (filePath: string) => void): void {
    this.onFileChange = callback;
  }

  setOnFileDelete(callback: (filePath: string) => void): void {
    this.onFileDelete = callback;
  }
  
  private static readonly IGNORED_SEGMENTS = [
    '/node_modules/', '/.venv/', '/venv/', '/.git/', '/dist/', '/build/', '/data/',
  ];
  private static readonly CODE_EXT = /\.(ts|tsx|js|jsx|py)$/;

  /** Same file set the old glob patterns described. */
  static isWatchedCodePath(absPath: string): boolean {
    const normalized = absPath.replace(/\\/g, '/');
    for (const seg of CodeFileWatcher.IGNORED_SEGMENTS) {
      if (normalized.includes(seg)) return false;
    }
    const base = path.basename(normalized);
    if (base === 'job.json' || base === 'data-sources.json') return true;
    return CodeFileWatcher.CODE_EXT.test(base);
  }

  /**
   * Start watching for file changes
   */
  start(): void {
    console.log('👀 Starting code file watcher...');
    console.log(`   Watching: ${this.paprDir}`);
    
    // chokidar ≥4 has no glob support, so the previous `apps/**/*.{ts,...}`
    // patterns were watching literal paths that never existed. Watch the two
    // roots recursively (1 OS handle each) and filter by extension here.
    const roots = [
      path.join(this.paprDir, 'apps'),
      path.join(this.paprDir, 'Jobs'),
    ];

    this.watcher = new TreeWatcher({
      roots,
      recursive: true,
      settleMs: 2000, // was awaitWriteFinish.stabilityThreshold
      ignore: (absPath) => !CodeFileWatcher.isWatchedCodePath(absPath),
      onEvent: (event) => {
        if (event.type === 'unlink') {
          void this.handleDelete(event.path);
        } else {
          void this.handleChange(event.path, event.type === 'add' ? 'added' : 'changed');
        }
      },
      onError: (err, root) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // root not created yet
        console.error('❌ Watcher error:', root, err.message);
      },
    });

    console.log('✅ File watcher started');
  }
  
  /**
   * Stop watching
   */
  stop(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
      console.log('🛑 File watcher stopped');
    }
  }
  
  /**
   * Handle file add/change
   */
  private async handleChange(filePath: string, action: string): Promise<void> {
    console.log(`📝 File ${action}: ${path.relative(this.paprDir, filePath)}`);
    
    try {
      if (!isIndexableCodePath(filePath, this.paprDir)) {
        console.log(`   ⚠️  Ignoring unindexable path: ${path.relative(this.paprDir, filePath)}`);
        return;
      }

      const relativePath = path.relative(this.paprDir, filePath);
      console.log(`   ✓ Queueing for re-index: ${relativePath}`);
      
      // Notify the manager to queue this file
      if (this.onFileChange) {
        this.onFileChange(filePath);
        console.log(`   🔄 File queued for batch indexing (debounced 5s)`);
      } else {
        console.log('   💡 No callback registered - run full indexing: npm run index:code');
      }
      
    } catch (error) {
      console.error(`   ❌ Failed to handle change: ${(error as Error).message}`);
    }
  }
  
  /**
   * Handle file deletion
   */
  private async handleDelete(filePath: string): Promise<void> {
    console.log(`🗑️  File deleted: ${path.relative(this.paprDir, filePath)}`);

    if (!isIndexableCodePath(filePath, this.paprDir)) {
      return;
    }

    if (this.onFileDelete) {
      this.onFileDelete(filePath);
      console.log('   🔄 Summary cache updated for deleted file');
    }
  }
  
}
