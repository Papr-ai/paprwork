/**
 * Code Index Tracker
 * 
 * Tracks which files have been indexed to PAPR Memory Cloud using SQLite.
 * Provides hash-based change detection to skip unchanged files.
 */

import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface IndexedFile {
  file_path: string;
  content_hash: string;
  last_indexed_at: Date;
  schema_version: string;
  memory_id?: string;
  project_id: string;
  lines_of_code: number;
  language: string;
}

export interface IndexedProject {
  project_id: string;
  project_type: 'mini_app' | 'job';
  last_indexed_at: Date;
  memory_id?: string;
  file_count: number;
}

export interface QueuedFile {
  file_path: string;
  queued_at: Date;
  priority: number; // 0=normal, 1=high (new file)
}

export class CodeIndexTracker {
  private db: Database.Database;
  private dbPath: string;
  
  constructor(dataDir?: string) {
    const baseDir = dataDir || path.join(os.homedir(), '.paprwork-v2');
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
    
    this.dbPath = path.join(baseDir, 'code-index.db');
    this.db = new Database(this.dbPath);
    this.initSchema();
  }
  
  /**
   * Initialize database schema
   */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexed_files (
        file_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        last_indexed_at DATETIME NOT NULL,
        schema_version TEXT NOT NULL,
        memory_id TEXT,
        project_id TEXT NOT NULL,
        lines_of_code INTEGER NOT NULL,
        language TEXT NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS indexed_projects (
        project_id TEXT PRIMARY KEY,
        project_type TEXT NOT NULL,
        last_indexed_at DATETIME NOT NULL,
        memory_id TEXT,
        file_count INTEGER NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS index_queue (
        file_path TEXT PRIMARY KEY,
        queued_at DATETIME NOT NULL,
        priority INTEGER DEFAULT 0
      );
      
      CREATE INDEX IF NOT EXISTS idx_queue_priority ON index_queue(priority DESC, queued_at ASC);
    `);
  }
  
  /**
   * Calculate SHA-256 hash of file content
   */
  calculateFileHash(filePath: string): string {
    const content = fs.readFileSync(filePath, 'utf-8');
    return crypto.createHash('sha256').update(content).digest('hex');
  }
  
  /**
   * Check if file needs indexing (new or changed)
   */
  needsIndexing(filePath: string): boolean {
    const currentHash = this.calculateFileHash(filePath);
    
    const row = this.db.prepare(
      'SELECT content_hash FROM indexed_files WHERE file_path = ?'
    ).get(filePath) as { content_hash: string } | undefined;
    
    if (!row) {
      return true; // New file
    }
    
    return row.content_hash !== currentHash; // Changed file
  }
  
  /**
   * Record indexed file
   */
  recordIndexedFile(file: IndexedFile): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO indexed_files 
      (file_path, content_hash, last_indexed_at, schema_version, memory_id, project_id, lines_of_code, language)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      file.file_path,
      file.content_hash,
      file.last_indexed_at.toISOString(),
      file.schema_version,
      file.memory_id,
      file.project_id,
      file.lines_of_code,
      file.language
    );
  }
  
  /**
   * Record indexed project
   */
  recordIndexedProject(project: IndexedProject): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO indexed_projects
      (project_id, project_type, last_indexed_at, memory_id, file_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      project.project_id,
      project.project_type,
      project.last_indexed_at.toISOString(),
      project.memory_id,
      project.file_count
    );
  }
  
  /**
   * Add file to index queue
   */
  queueFile(filePath: string, priority: number = 0): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO index_queue (file_path, queued_at, priority)
      VALUES (?, ?, ?)
    `).run(filePath, new Date().toISOString(), priority);
  }
  
  /**
   * Get next batch of files from queue
   */
  getQueuedFiles(limit: number = 50): QueuedFile[] {
    const rows = this.db.prepare(`
      SELECT file_path, queued_at, priority 
      FROM index_queue 
      ORDER BY priority DESC, queued_at ASC
      LIMIT ?
    `).all(limit) as Array<{ file_path: string; queued_at: string; priority: number }>;
    
    return rows.map(row => ({
      file_path: row.file_path,
      queued_at: new Date(row.queued_at),
      priority: row.priority
    }));
  }
  
  /**
   * Remove file from queue
   */
  dequeueFile(filePath: string): void {
    this.db.prepare('DELETE FROM index_queue WHERE file_path = ?').run(filePath);
  }
  
  /**
   * Get queue size
   */
  getQueueSize(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM index_queue').get() as { count: number };
    return row.count;
  }
  
  /**
   * Get total indexed files count
   */
  getIndexedFilesCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM indexed_files').get() as { count: number };
    return row.count;
  }
  
  /**
   * Get all indexed files for a project
   */
  getProjectFiles(projectId: string): IndexedFile[] {
    const rows = this.db.prepare(`
      SELECT * FROM indexed_files WHERE project_id = ?
    `).all(projectId) as Array<{
      file_path: string;
      content_hash: string;
      last_indexed_at: string;
      schema_version: string;
      memory_id?: string;
      project_id: string;
      lines_of_code: number;
      language: string;
    }>;
    
    return rows.map(row => ({
      file_path: row.file_path,
      content_hash: row.content_hash,
      last_indexed_at: new Date(row.last_indexed_at),
      schema_version: row.schema_version,
      memory_id: row.memory_id,
      project_id: row.project_id,
      lines_of_code: row.lines_of_code,
      language: row.language
    }));
  }
  
  /**
   * Get indexing statistics
   */
  getStats(): {
    total_files: number;
    total_projects: number;
    queue_size: number;
    last_indexed_at?: Date;
  } {
    const filesCount = this.getIndexedFilesCount();
    
    const projectsRow = this.db.prepare(
      'SELECT COUNT(*) as count FROM indexed_projects'
    ).get() as { count: number };
    
    const queueSize = this.getQueueSize();
    
    const lastIndexedRow = this.db.prepare(`
      SELECT MAX(last_indexed_at) as last_indexed 
      FROM indexed_files
    `).get() as { last_indexed?: string };
    
    return {
      total_files: filesCount,
      total_projects: projectsRow.count,
      queue_size: queueSize,
      last_indexed_at: lastIndexedRow.last_indexed 
        ? new Date(lastIndexedRow.last_indexed) 
        : undefined
    };
  }
  
  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
