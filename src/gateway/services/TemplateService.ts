import path from "path";
import { promises as fs } from "fs";
import { getAppService, type MiniApp } from "./AppService.js";
import { getJobsService, type JobRecord } from "./JobsService.js";

export interface CreatePipelineTemplateInput {
  name: string;
  description?: string;
}

export interface PipelineTemplateResult {
  app: MiniApp;
  job: JobRecord;
  jobPath: string;
  dbPath: string;
}

let templateServiceInstance: TemplateService | null = null;

export class TemplateService {
  async createPipelineTemplate(
    input: CreatePipelineTemplateInput,
  ): Promise<PipelineTemplateResult> {
    const appService = getAppService();
    const jobsService = getJobsService();
    await appService.initialize();
    await jobsService.initialize();

    const baseName = input.name.trim() || "Pipeline Template";
    const safeSlug = baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const description =
      input.description?.trim() ||
      "Starter pipeline with Python job + SQLite + mini-app.";

    const app = await appService.createApp(baseName, description, [
      {
        filename: "index.html",
        content: `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${baseName}</title>
    <style>
      body { font-family: -apple-system, sans-serif; margin: 24px; color: #1d1d1f; }
      h1 { margin-bottom: 8px; }
      code, pre { background: #f5f5f7; padding: 4px 6px; border-radius: 6px; }
      .meta { color: #6e6e73; margin-bottom: 16px; }
    </style>
  </head>
  <body>
    <h1>${baseName}</h1>
    <p class="meta">${description}</p>
    <p>This template pairs a Python job with SQLite output.</p>
    <p>Run job <code>${safeSlug}-collector</code>, then inspect data in <code>events</code>.</p>
    <pre id="status">Template scaffold complete. Connect query adapters next.</pre>
  </body>
</html>`,
      },
    ]);

    const job = await jobsService.createJob({
      name: `${safeSlug}-collector`,
      type: "python",
      command: "python3 code/main.py",
    });
    const jobPath = await jobsService.getJobPath(job.id);
    const dbPath = await jobsService.getJobDatabasePath(job.id);
    if (!jobPath || !dbPath) {
      throw new Error("Failed to resolve template job paths");
    }

    const pythonEntryPath = path.join(jobPath, "code", "main.py");
    const migrationPath = path.join(jobPath, "migrations", "0002_events.sql");
    const seedNotesPath = path.join(jobPath, "README.md");

    await Promise.all([
      fs.writeFile(
        pythonEntryPath,
        `#!/usr/bin/env python3
import sqlite3
from datetime import datetime
from pathlib import Path

db_path = Path(__file__).parent.parent / "data" / "data.db"
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("""
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
)
""")
cur.execute(
  "INSERT INTO events (event_type, payload, created_at) VALUES (?, ?, ?)",
  ("template_run", "pipeline template executed", datetime.utcnow().isoformat()),
)
conn.commit()
conn.close()
print("Inserted template event into", db_path)
`,
        "utf8",
      ),
      fs.writeFile(
        migrationPath,
        `-- Optional follow-up migration for template users
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  captured_at TEXT NOT NULL
);
`,
        "utf8",
      ),
      fs.writeFile(
        seedNotesPath,
        `# ${baseName} Job Template

- Entry: \`code/main.py\`
- Database: \`data/data.db\`
- Default table: \`events\`

Run with:
\`\`\`bash
python3 code/main.py
\`\`\`
`,
        "utf8",
      ),
    ]);

    return {
      app,
      job,
      jobPath,
      dbPath,
    };
  }
}

export function getTemplateService(): TemplateService {
  if (!templateServiceInstance) {
    templateServiceInstance = new TemplateService();
  }
  return templateServiceInstance;
}
