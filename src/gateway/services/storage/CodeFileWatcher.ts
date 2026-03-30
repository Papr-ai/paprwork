/**
 * Code File Watcher
 * 
 * Watches ~/PAPR folder for code changes and auto-reindexes.
 */

import chokidar, { FSWatcher } from 'chokidar';
import * as path from 'path';
import * as os from 'os';
import { Papr } from '@papr/memory';
// import { CodeIndexerService } from './CodeIndexerService.js';

export class CodeFileWatcher {
  private watcher: FSWatcher | null = null;
  private paprDir: string;
  
  constructor(
    _client: Papr,
    _schemaId: string,
    paprDir?: string
  ) {
    this.paprDir = paprDir || path.join(os.homedir(), 'PAPR');
    // Store for future use in re-indexing
    // this.client = _client;
    // this.schemaId = _schemaId;
  }
  
  /**
   * Start watching for file changes
   */
  start(): void {
    console.log('👀 Starting code file watcher...');
    console.log(`   Watching: ${this.paprDir}`);
    
    const patterns = [
      `${this.paprDir}/apps/**/*.{ts,tsx,js,jsx,py}`,
      `${this.paprDir}/Jobs/**/*.{ts,tsx,js,jsx,py}`,
      `${this.paprDir}/Jobs/**/job.json`,
      `${this.paprDir}/apps/**/data-sources.json`,
      `${this.paprDir}/Jobs/**/data-sources.json`
    ];
    
    this.watcher = chokidar.watch(patterns, {
      ignored: [
        '**/node_modules/**',
        '**/.venv/**',
        '**/venv/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/data/**'
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100
      }
    });
    
    this.watcher
      .on('add', (filePath: string) => this.handleChange(filePath, 'added'))
      .on('change', (filePath: string) => this.handleChange(filePath, 'changed'))
      .on('unlink', (filePath: string) => this.handleDelete(filePath))
      .on('error', (err: unknown) => console.error('❌ Watcher error:', err));
    
    console.log('✅ File watcher started');
  }
  
  /**
   * Stop watching
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      console.log('🛑 File watcher stopped');
    }
  }
  
  /**
   * Handle file add/change
   */
  private async handleChange(filePath: string, action: string): Promise<void> {
    console.log(`📝 File ${action}: ${path.relative(this.paprDir, filePath)}`);
    
    try {
      // Determine if this is a job or mini-app (use path.sep for cross-platform)
      const pathParts = filePath.split(path.sep);
      const isJob = pathParts.includes('Jobs');
      const isMiniApp = pathParts.includes('apps');
      
      if (!isJob && !isMiniApp) {
        console.log('   ⚠️  Ignoring file outside Jobs/apps folders');
        return;
      }
      
      // Extract project ID from path
      const projectId = this.extractProjectId(filePath, isJob);
      if (!projectId) {
        console.log('   ⚠️  Could not extract project ID');
        return;
      }
      
      // For now, log that we would re-index
      // In production, you'd call a method to re-index just this project
      console.log(`   ✓ Would re-index project: ${projectId}`);
      
      // TODO: Implement actual re-indexing
      // const indexer = new CodeIndexerService(this.client, this.schemaId, this.paprDir);
      // const projectPath = isJob
      //   ? path.join(this.paprDir, 'Jobs', projectId)
      //   : path.join(this.paprDir, 'apps', projectId);
      // await indexer.indexProject(projectPath);
      console.log('   💡 Run full indexing to update: npm run index:code');
      
    } catch (error) {
      console.error(`   ❌ Failed to handle change: ${(error as Error).message}`);
    }
  }
  
  /**
   * Handle file deletion
   */
  private async handleDelete(filePath: string): Promise<void> {
    console.log(`🗑️  File deleted: ${path.relative(this.paprDir, filePath)}`);
    console.log('   💡 Note: Deleted files remain in memory (historical record)');
  }
  
  /**
   * Extract project ID from file path
   */
  private extractProjectId(filePath: string, isJob: boolean): string | null {
    const parts = filePath.split(path.sep);
    const targetFolder = isJob ? 'Jobs' : 'apps';
    const folderIndex = parts.indexOf(targetFolder);
    
    if (folderIndex >= 0 && folderIndex < parts.length - 1) {
      return parts[folderIndex + 1];
    }
    
    return null;
  }
}
