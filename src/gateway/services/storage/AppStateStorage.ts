/**
 * App State Storage - Persist UI state (tabs, favorites) in SQLite
 * 
 * This is much faster than localStorage for large datasets because:
 * 1. SQLite is optimized for structured data
 * 2. We only store metadata (IDs, types), not full content
 * 3. Can be loaded incrementally (only load what's needed)
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const APP_STATE_DIR = path.join(os.homedir(), '.paprwork-v2');
const APP_STATE_DB = path.join(APP_STATE_DIR, 'app-state.db');

export interface TabMetadata {
  id: string;
  type: 'chat' | 'document' | 'app' | 'job' | 'artifact';
  entityId: string;
  title: string;
  displayMode: 'standalone' | 'parent' | 'child';
  parentTabId: string | null;
  position: number; // Order in tab bar
  isFavorite: boolean;
  createdAt: string;
  lastAccessedAt: string;
}

export interface AppState {
  activeTabId: string | null;
  splitRatio: number;
  splitRatios: Record<string, number>; // Per-tab split ratios (tabId → ratio)
  history: string[]; // Navigation history (tab IDs)
  historyIndex: number; // Current position in history
  onboardingStep1Completed: boolean;
  onboardingStep2Completed: boolean;
  onboardingStep3Completed: boolean;
  onboardingDismissed: boolean;
  lastSavedAt: string;
}

export class AppStateStorage {
  private db: Database.Database;

  constructor() {
    // Ensure directory exists
    if (!fs.existsSync(APP_STATE_DIR)) {
      fs.mkdirSync(APP_STATE_DIR, { recursive: true });
    }

    // Open database with performance optimizations
    this.db = new Database(APP_STATE_DB);
    
    // Performance optimizations
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -5000'); // 5MB cache
    this.db.pragma('mmap_size = 15000000'); // 15MB mmap
    this.db.pragma('temp_store = MEMORY');
    
    // Create tables
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tabs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        title TEXT NOT NULL,
        display_mode TEXT NOT NULL,
        parent_tab_id TEXT,
        position INTEGER NOT NULL,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tabs_position ON tabs(position);
      CREATE INDEX IF NOT EXISTS idx_tabs_favorite ON tabs(is_favorite);
    `);
  }

  /**
   * Save tabs (replaces all tabs)
   */
  saveTabs(tabs: TabMetadata[]): void {
    const transaction = this.db.transaction((tabsToSave: TabMetadata[]) => {
      // Clear existing tabs
      this.db.prepare('DELETE FROM tabs').run();
      
      // Insert new tabs
      const stmt = this.db.prepare(`
        INSERT INTO tabs (
          id, type, entity_id, title, display_mode, parent_tab_id,
          position, is_favorite, created_at, last_accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const tab of tabsToSave) {
        stmt.run(
          tab.id,
          tab.type,
          tab.entityId,
          tab.title,
          tab.displayMode,
          tab.parentTabId,
          tab.position,
          tab.isFavorite ? 1 : 0,
          tab.createdAt,
          tab.lastAccessedAt
        );
      }
    });

    transaction(tabs);
  }

  /**
   * Load all tabs
   */
  loadTabs(): TabMetadata[] {
    const rows = this.db.prepare(`
      SELECT * FROM tabs ORDER BY position ASC
    `).all() as any[];

    return rows.map(row => ({
      id: row.id,
      type: row.type,
      entityId: row.entity_id,
      title: row.title,
      displayMode: row.display_mode,
      parentTabId: row.parent_tab_id,
      position: row.position,
      isFavorite: row.is_favorite === 1,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
    }));
  }

  /**
   * Save app state (active tab, split ratio, onboarding, etc.)
   */
  saveAppState(state: AppState): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO app_state (key, value, updated_at)
      VALUES (?, ?, ?)
    `);

    const now = new Date().toISOString();
    stmt.run('activeTabId', state.activeTabId || '', now);
    stmt.run('splitRatio', state.splitRatio.toString(), now);
    stmt.run('splitRatios', JSON.stringify(state.splitRatios), now);
    stmt.run('history', JSON.stringify(state.history), now);
    stmt.run('historyIndex', state.historyIndex.toString(), now);
    stmt.run('onboardingStep1Completed', state.onboardingStep1Completed.toString(), now);
    stmt.run('onboardingStep2Completed', state.onboardingStep2Completed.toString(), now);
    stmt.run('onboardingStep3Completed', state.onboardingStep3Completed.toString(), now);
    stmt.run('onboardingDismissed', state.onboardingDismissed.toString(), now);
    stmt.run('lastSavedAt', state.lastSavedAt, now);
  }

  /**
   * Load app state
   */
  loadAppState(): AppState | null {
    const rows = this.db.prepare(`
      SELECT key, value FROM app_state
    `).all() as { key: string; value: string }[];

    if (rows.length === 0) return null;

    const stateMap = new Map(rows.map(r => [r.key, r.value]));

    return {
      activeTabId: stateMap.get('activeTabId') || null,
      splitRatio: parseFloat(stateMap.get('splitRatio') || '0.5'),
      splitRatios: JSON.parse(stateMap.get('splitRatios') || '{}'),
      history: JSON.parse(stateMap.get('history') || '[]'),
      historyIndex: parseInt(stateMap.get('historyIndex') || '-1', 10),
      onboardingStep1Completed: stateMap.get('onboardingStep1Completed') === 'true',
      onboardingStep2Completed: stateMap.get('onboardingStep2Completed') === 'true',
      onboardingStep3Completed: stateMap.get('onboardingStep3Completed') === 'true',
      onboardingDismissed: stateMap.get('onboardingDismissed') === 'true',
      lastSavedAt: stateMap.get('lastSavedAt') || new Date().toISOString(),
    };
  }

  /**
   * Toggle favorite status for a tab
   */
  toggleFavorite(tabId: string): void {
    this.db.prepare(`
      UPDATE tabs
      SET is_favorite = CASE WHEN is_favorite = 1 THEN 0 ELSE 1 END
      WHERE id = ?
    `).run(tabId);
  }

  /**
   * Update last accessed time for a tab
   */
  updateLastAccessed(tabId: string): void {
    this.db.prepare(`
      UPDATE tabs
      SET last_accessed_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), tabId);
  }

  /**
   * Get favorites only
   */
  getFavorites(): TabMetadata[] {
    const rows = this.db.prepare(`
      SELECT * FROM tabs
      WHERE is_favorite = 1
      ORDER BY last_accessed_at DESC
    `).all() as any[];

    return rows.map(row => ({
      id: row.id,
      type: row.type,
      entityId: row.entity_id,
      title: row.title,
      displayMode: row.display_mode,
      parentTabId: row.parent_tab_id,
      position: row.position,
      isFavorite: true,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
    }));
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

// Singleton instance
let instance: AppStateStorage | null = null;

export function getAppStateStorage(): AppStateStorage {
  if (!instance) {
    instance = new AppStateStorage();
  }
  return instance;
}
