/**
 * WorkspaceService - Manages agent workspace files for persistent context
 *
 * Workspace files live in ~/Papr/workspace/ and are injected into the system
 * prompt on every agent turn. The agent reads and writes these files using
 * existing tools (write_file, bash) to improve itself over time.
 *
 * Inspired by OpenClaw's bootstrap file injection pattern.
 *
 * Files:
 *   MEMORY.md    - Long-term curated memory (decisions, preferences, patterns)
 *   IDENTITY.md  - User profile (name, role, tone, goals)
 *   AGENTS.md    - Operating contract (workflow rules, boundaries)
 *   TOOLS.md     - Environment notes (CLIs, APIs, paths)
 *   BRAND.md     - User/company visual identity (colors, fonts, logo, voice)
 *   brand.json   - Structured brand tokens for mini-apps (mirrors BRAND.md)
 *   ONBOARD.md   - First-run interview script (deleted after completion)
 *   memory/YYYY-MM-DD.md - Daily working logs (append-only)
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Maximum characters per injected workspace file */
const MAX_CHARS_PER_FILE = 20_000;

/** Maximum total characters across all injected workspace content */
const MAX_TOTAL_CHARS = 80_000;

/** Workspace files to inject (in order of priority) */
const WORKSPACE_FILES = [
  "IDENTITY.md",
  "BRAND.md",
  "MEMORY.md",
  "AGENTS.md",
  "TOOLS.md",
] as const;

/** A loaded workspace file with truncation metadata */
export interface WorkspaceFile {
  name: string;
  content: string;
  truncated: boolean;
  rawLength: number;
}

/** Full workspace context ready for system prompt injection */
export interface WorkspaceContext {
  files: WorkspaceFile[];
  dailyLogs: WorkspaceFile[];
  onboardingPending: boolean;
  onboardContent: string | null;
  totalChars: number;
}

export class WorkspaceService {
  private workspaceDir: string;
  private memoryDir: string;
  private initialized = false;

  constructor() {
    const homeDir = os.homedir();
    this.workspaceDir = path.join(homeDir, "Papr", "workspace");
    this.memoryDir = path.join(this.workspaceDir, "memory");
  }

  /** Get the workspace directory path */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  /**
   * Initialize workspace directory with template files on first run.
   * Safe to call multiple times (idempotent).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create workspace directory structure
    await fs.mkdir(this.workspaceDir, { recursive: true });
    await fs.mkdir(this.memoryDir, { recursive: true });
    await fs.mkdir(path.join(this.memoryDir, "archive"), { recursive: true });
    await fs.mkdir(path.join(this.workspaceDir, "brand"), { recursive: true });

    // Copy template files if they don't exist yet
    const templatesDir = this.resolveTemplatesDir();
    const templateFiles = [
      "MEMORY.md",
      "IDENTITY.md",
      "BRAND.md",
      "brand.json",
      "AGENTS.md",
      "TOOLS.md",
      "ONBOARD.md",
      "SLEEP.md",
    ];

    for (const filename of templateFiles) {
      const destPath = path.join(this.workspaceDir, filename);
      const exists = await this.fileExists(destPath);
      if (!exists) {
        const srcPath = path.join(templatesDir, filename);
        const srcExists = await this.fileExists(srcPath);
        if (srcExists) {
          const content = await fs.readFile(srcPath, "utf8");
          await fs.writeFile(destPath, content, "utf8");
          console.log(`[WorkspaceService] Created template: ${filename}`);
        } else {
          // Fallback: create minimal placeholder
          await fs.writeFile(
            destPath,
            `# ${filename.replace(".md", "")}\n\n`,
            "utf8",
          );
          console.log(`[WorkspaceService] Created placeholder: ${filename}`);
        }
      }
    }

    const { seedIdentityAboutFromProfile } = await import(
      "./identityAboutSeed.js"
    );
    await seedIdentityAboutFromProfile();

    this.initialized = true;
    console.log(
      `[WorkspaceService] Workspace initialized at ${this.workspaceDir}`,
    );
  }

  /**
   * Load all workspace files for system prompt injection.
   * Applies per-file and total truncation limits.
   */
  async loadWorkspaceContext(): Promise<WorkspaceContext> {
    const files: WorkspaceFile[] = [];
    let totalChars = 0;

    // Load core workspace files (in priority order)
    for (const filename of WORKSPACE_FILES) {
      if (totalChars >= MAX_TOTAL_CHARS) break;

      const filePath = path.join(this.workspaceDir, filename);
      const loaded = await this.loadAndTruncate(
        filePath,
        filename,
        MAX_TOTAL_CHARS - totalChars,
      );
      if (loaded) {
        files.push(loaded);
        totalChars += loaded.content.length;
      }
    }

    // Load daily logs (today + yesterday)
    const dailyLogs = await this.loadDailyLogs(MAX_TOTAL_CHARS - totalChars);
    for (const log of dailyLogs) {
      totalChars += log.content.length;
    }

    // If sleep cycle or chat already populated IDENTITY, close stale ONBOARD.md
    await this.autoCompleteOnboardingIfReady();

    // Check onboarding status
    const onboardPath = path.join(this.workspaceDir, "ONBOARD.md");
    const onboardCompletedPath = path.join(
      this.workspaceDir,
      "ONBOARD.completed.md",
    );
    const onboardExists = await this.fileExists(onboardPath);
    const onboardCompleted = await this.fileExists(onboardCompletedPath);
    const onboardingPending = onboardExists && !onboardCompleted;

    let onboardContent: string | null = null;
    if (onboardingPending) {
      try {
        onboardContent = await fs.readFile(onboardPath, "utf8");
        if (onboardContent.length > MAX_CHARS_PER_FILE) {
          onboardContent =
            onboardContent.substring(0, MAX_CHARS_PER_FILE) +
            "\n\n[... truncated at 20,000 chars ...]";
        }
      } catch {
        // File read error — skip onboarding content
      }
    }

    return {
      files,
      dailyLogs,
      onboardingPending,
      onboardContent,
      totalChars,
    };
  }

  /**
   * Check if onboarding has been completed.
   */
  async isOnboardingComplete(): Promise<boolean> {
    const onboardPath = path.join(this.workspaceDir, "ONBOARD.md");
    const completedPath = path.join(this.workspaceDir, "ONBOARD.completed.md");

    const onboardExists = await this.fileExists(onboardPath);
    const completedExists = await this.fileExists(completedPath);

    // Complete if: ONBOARD.md doesn't exist, OR ONBOARD.completed.md exists
    return !onboardExists || completedExists;
  }

  /**
   * Rename ONBOARD.md when IDENTITY is already populated (e.g. sleep cycle wrote profile
   * but the first-run chat never ran the completion mv step).
   */
  async autoCompleteOnboardingIfReady(): Promise<boolean> {
    const onboardPath = path.join(this.workspaceDir, "ONBOARD.md");
    const onboardCompletedPath = path.join(
      this.workspaceDir,
      "ONBOARD.completed.md",
    );

    if (
      !(await this.fileExists(onboardPath)) ||
      (await this.fileExists(onboardCompletedPath))
    ) {
      return false;
    }

    const { getWorkspaceFileHealth } = await import("./identityAboutSeed.js");
    const health = await getWorkspaceFileHealth();
    if (!health.identityAboutComplete) {
      return false;
    }

    try {
      await fs.rename(onboardPath, onboardCompletedPath);
      console.log(
        "[WorkspaceService] Auto-completed onboarding — IDENTITY.md already populated",
      );
      return true;
    } catch (error) {
      console.warn(
        "[WorkspaceService] Failed to auto-complete onboarding:",
        (error as Error).message,
      );
      return false;
    }
  }

  // ——— Private helpers ———

  /**
   * Load today's and yesterday's daily memory logs.
   */
  private async loadDailyLogs(
    remainingBudget: number,
  ): Promise<WorkspaceFile[]> {
    const logs: WorkspaceFile[] = [];
    let budget = remainingBudget;

    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const dates = [
      { date: yesterday, label: "yesterday" },
      { date: today, label: "today" },
    ];

    for (const { date, label } of dates) {
      if (budget <= 0) break;

      const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
      const filename = `${dateStr}.md`;
      const filePath = path.join(this.memoryDir, filename);
      const loaded = await this.loadAndTruncate(
        filePath,
        `memory/${filename} (${label})`,
        budget,
      );
      if (loaded) {
        logs.push(loaded);
        budget -= loaded.content.length;
      }
    }

    return logs;
  }

  /**
   * Load a file and truncate to fit within limits.
   */
  private async loadAndTruncate(
    filePath: string,
    displayName: string,
    remainingBudget: number,
  ): Promise<WorkspaceFile | null> {
    try {
      const exists = await this.fileExists(filePath);
      if (!exists) return null;

      const raw = await fs.readFile(filePath, "utf8");
      if (raw.trim().length === 0) return null;

      const maxChars = Math.min(MAX_CHARS_PER_FILE, remainingBudget);
      let content = raw;
      let truncated = false;

      if (content.length > maxChars) {
        content =
          content.substring(0, maxChars) +
          "\n\n[... truncated at 20,000 chars ...]";
        truncated = true;
      }

      return {
        name: displayName,
        content,
        truncated,
        rawLength: raw.length,
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolve the path to bundled workspace templates.
   * Handles both dev (src/resources/) and production (dist/) layouts.
   */
  private resolveTemplatesDir(): string {
    // Try relative to this file first (gateway/services/ -> ../../resources/)
    const candidates = [
      path.resolve(__dirname, "../../resources/workspace-templates"),
      path.resolve(__dirname, "../../../src/resources/workspace-templates"),
      path.resolve(process.cwd(), "src/resources/workspace-templates"),
    ];

    // Return first candidate — we'll check file existence when copying
    return candidates[0];
  }

  /**
   * Check if a file exists without throwing.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure the built-in "papr-sleep" agent job exists.
   * Delegates to SleepCycleService for dedupe, config, and prompt sync.
   */
  async ensureSleepJob(): Promise<void> {
    const { getSleepCycleService } = await import("./SleepCycleService.js");
    await getSleepCycleService().syncSleepJobs();
  }

  /**
   * Ensure the built-in "wiki-writer" agent job exists.
   * Delegates to WikiWriterService for dedupe, config, and prompt sync.
   */
  async ensureWikiWriterJob(): Promise<void> {
    const { getWikiWriterService } = await import("./WikiWriterService.js");
    await getWikiWriterService().syncWikiWriterJobs();
  }

  /**
   * Create checkpoint-aware job template in job directory.
   * Called by JobsService after job creation if template is requested.
   */
  async createCheckpointJobTemplate(
    jobDir: string,
    jobType: "python" | "node",
  ): Promise<void> {
    if (jobType === "python") {
      const templatePath = path.join(jobDir, "code", "main.py");
      const template = `#!/usr/bin/env python3
"""
Checkpoint-aware job template.

This template shows how to implement resumable processing for large datasets.
The job saves progress after every batch, so it can resume from where it left
off if interrupted or if retries are triggered.
"""

import sqlite3
from pathlib import Path
from datetime import datetime

# Database path (relative to this script)
db_path = Path(__file__).parent.parent / "data" / "data.db"

def initialize_schema(conn):
    """Create tables on first run."""
    cur = conn.cursor()
    
    # Main data table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      processed_at TEXT NOT NULL
    )
    """)
    
    # Checkpoint table tracks progress
    cur.execute("""
    CREATE TABLE IF NOT EXISTS checkpoint (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """)
    
    conn.commit()

def load_checkpoint(conn, key, default=0):
    """Load checkpoint value, or return default if not found."""
    cur = conn.cursor()
    cur.execute("SELECT value FROM checkpoint WHERE key=?", (key,))
    row = cur.fetchone()
    return int(row[0]) if row else default

def save_checkpoint(conn, key, value):
    """Save checkpoint value."""
    cur = conn.cursor()
    cur.execute("""
    INSERT OR REPLACE INTO checkpoint (key, value, updated_at)
    VALUES (?, ?, ?)
    """, (key, str(value), datetime.utcnow().isoformat()))
    conn.commit()

def process_batch(conn, start_id, batch_size):
    """
    Process a batch of items.
    Replace this with your actual processing logic.
    """
    cur = conn.cursor()
    
    for i in range(batch_size):
        item_id = start_id + i
        
        # TODO: Replace with your processing logic
        # Example: fetch from API, transform data, etc.
        data = f"Processed item {item_id}"
        
        cur.execute(
            "INSERT INTO items (data, processed_at) VALUES (?, ?)",
            (data, datetime.utcnow().isoformat())
        )
    
    conn.commit()

def main():
    """Main processing loop with checkpointing."""
    conn = sqlite3.connect(db_path)
    
    # Initialize schema on first run
    initialize_schema(conn)
    
    # Load checkpoint
    last_id = load_checkpoint(conn, "last_processed_id", default=0)
    print(f"Resuming from ID {last_id}")
    
    # Process in batches
    BATCH_SIZE = 100
    TOTAL_ITEMS = 10_000  # TODO: Replace with your total item count
    
    current_id = last_id
    while current_id < TOTAL_ITEMS:
        batch_size = min(BATCH_SIZE, TOTAL_ITEMS - current_id)
        
        # Process batch
        process_batch(conn, current_id, batch_size)
        current_id += batch_size
        
        # Save checkpoint after each batch
        save_checkpoint(conn, "last_processed_id", current_id)
        
        print(f"Checkpoint: {current_id}/{TOTAL_ITEMS} items processed")
    
    print(f"Processing complete! Total: {TOTAL_ITEMS} items")
    conn.close()

if __name__ == "__main__":
    main()
`;

      await fs.writeFile(templatePath, template, "utf8");

      // Also create README explaining the pattern
      const readmePath = path.join(jobDir, "README.md");
      const readme = `# Checkpoint-Aware Job Template

This job implements checkpointing for resumable processing.

## How it works

1. **Checkpoint table** tracks progress (last processed ID)
2. **Batch processing** saves checkpoint after every 100 items
3. **Resume on retry** loads last checkpoint and continues

## Testing resilience

\`\`\`bash
# Run normally
python3 code/main.py

# Simulate crash (Ctrl+C during run)
# Then run again - it resumes from last checkpoint

# View progress
sqlite3 data/data.db "SELECT * FROM checkpoint"
\`\`\`

## Adapting for your use case

Replace the \`process_batch()\` function with your actual logic:
- API calls
- Data transformations
- File processing
- Database operations

The checkpoint pattern works for any sequential processing task.
`;

      await fs.writeFile(readmePath, readme, "utf8");
    }

    // TODO: Add Node.js template if needed
  }
}

// Singleton
let workspaceServiceInstance: WorkspaceService | null = null;

export function getWorkspaceService(): WorkspaceService {
  if (!workspaceServiceInstance) {
    workspaceServiceInstance = new WorkspaceService();
  }
  return workspaceServiceInstance;
}

export async function initializeWorkspaceService(): Promise<WorkspaceService> {
  const service = getWorkspaceService();
  await service.initialize();
  return service;
}
