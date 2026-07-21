/**
 * Orchestrates file + project summary generation and local/Papr persistence.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Papr } from '@papr/memory';
import { CodeIndexTracker } from './CodeIndexTracker.js';
import { CodeSummaryGenerator } from './CodeSummaryGenerator.js';
import { CodeSummaryMemoryStore } from './CodeSummaryMemoryStore.js';
import { getProjectPathInfo, type ProjectPathInfo } from './codeIndexPaths.js';

interface ProjectDisplayInfo {
  projectId: string;
  projectType: 'mini_app' | 'job';
  projectName: string;
  projectDir: string;
}

export class CodeSummaryIndexPipeline {
  private generator = new CodeSummaryGenerator();
  private memoryStore: CodeSummaryMemoryStore;
  private pendingOverviewRebuilds = new Map<string, ProjectDisplayInfo>();

  constructor(
    private client: Papr,
    schemaId: string,
    private tracker: CodeIndexTracker,
    private paprDir: string,
  ) {
    this.memoryStore = new CodeSummaryMemoryStore(client, schemaId);
  }

  async processChangedFile(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const projectInfo = getProjectPathInfo(filePath, this.paprDir);
    if (!projectInfo) {
      return;
    }

    const hash = this.tracker.calculateFileHash(filePath);
    if (!this.tracker.needsSummaryUpdate(filePath, hash)) {
      return;
    }

    const display = this.loadProjectDisplayInfo(projectInfo);
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = path.basename(filePath);
    const language = this.generator.detectLanguage(path.extname(filePath));

    const summaryText = await this.generator.generateFileSummary({
      filePath,
      fileName,
      language,
      content,
      projectName: display.projectName,
      projectType: display.projectType,
    });

    if (!summaryText) {
      console.warn(`[CodeSummary] Skipped file summary (no LLM provider): ${fileName}`);
      return;
    }

    const previousMemoryId = this.tracker.getFileSummaryMemoryId(filePath);
    let memoryId: string | undefined;

    try {
      memoryId = await this.memoryStore.upsertFileSummary({
        content: summaryText,
        filePath,
        fileName,
        projectId: display.projectId,
        projectType: display.projectType,
        language,
        contentHash: hash,
        previousMemoryId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodeSummary] Papr upsert failed for ${fileName}: ${message}`);
    }

    this.tracker.saveFileSummary({
      file_path: filePath,
      project_id: display.projectId,
      file_name: fileName,
      summary_text: summaryText,
      content_hash: hash,
      memory_id: memoryId,
      language,
      updated_at: new Date(),
    });

    this.pendingOverviewRebuilds.set(display.projectId, display);
  }

  async flushPendingProjectOverviews(): Promise<void> {
    const pending = [...this.pendingOverviewRebuilds.values()];
    this.pendingOverviewRebuilds.clear();

    for (const display of pending) {
      await this.rebuildProjectOverview(display);
    }
  }

  async processDeletedFile(filePath: string): Promise<void> {
    const existing = this.tracker.getFileSummary(filePath);
    const projectInfo = getProjectPathInfo(filePath, this.paprDir);

    this.tracker.deleteFileSummary(filePath);
    this.tracker.removeIndexedFile(filePath);

    if (existing?.memory_id) {
      try {
        await this.client.memory.delete(existing.memory_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[CodeSummary] Failed to delete file summary memory ${existing.memory_id}: ${message}`,
        );
      }
    }

    if (projectInfo) {
      const display = this.loadProjectDisplayInfo(projectInfo);
      this.pendingOverviewRebuilds.set(display.projectId, display);
      await this.rebuildProjectOverview(display);
    }
  }

  private async rebuildProjectOverview(display: ProjectDisplayInfo): Promise<void> {
    const summaries = this.tracker.getFileSummariesForProject(display.projectId);
    const fileSummaries = summaries.map((summary) => ({
      fileName: summary.file_name,
      relativePath: this.generator.toRelativePath(summary.file_path, display.projectDir),
      summary: summary.summary_text,
    }));

    const overviewText = await this.generator.generateProjectOverview({
      projectId: display.projectId,
      projectName: display.projectName,
      projectType: display.projectType,
      fileSummaries,
    });

    if (!overviewText) {
      console.warn(
        `[CodeSummary] Skipped project overview (no LLM provider): ${display.projectId}`,
      );
      return;
    }

    const previousMemoryId = this.tracker.getProjectOverviewMemoryId(display.projectId);
    let memoryId: string | undefined;

    try {
      memoryId = await this.memoryStore.upsertProjectOverview({
        content: overviewText,
        projectId: display.projectId,
        projectType: display.projectType,
        projectName: display.projectName,
        fileCount: summaries.length,
        previousMemoryId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[CodeSummary] Papr upsert failed for project ${display.projectId}: ${message}`,
      );
    }

    this.tracker.saveProjectOverview({
      project_id: display.projectId,
      project_type: display.projectType,
      overview_text: overviewText,
      memory_id: memoryId,
      file_count: summaries.length,
      updated_at: new Date(),
    });
  }

  private loadProjectDisplayInfo(projectInfo: ProjectPathInfo): ProjectDisplayInfo {
    let projectName = projectInfo.projectId;

    if (projectInfo.type === 'job') {
      const jobJsonPath = path.join(projectInfo.projectDir, 'job.json');
      if (fs.existsSync(jobJsonPath)) {
        try {
          const jobJson = JSON.parse(fs.readFileSync(jobJsonPath, 'utf-8')) as {
            name?: string;
          };
          if (jobJson.name) {
            projectName = jobJson.name;
          }
        } catch {
          // Use project id fallback
        }
      }
    } else {
      const appsJsonPath = path.join(this.paprDir, 'data', 'apps.json');
      if (fs.existsSync(appsJsonPath)) {
        try {
          const apps = JSON.parse(fs.readFileSync(appsJsonPath, 'utf-8')) as Array<{
            id: string;
            title?: string;
          }>;
          const app = apps.find((entry) => entry.id === projectInfo.projectId);
          if (app?.title) {
            projectName = app.title;
          }
        } catch {
          // Use project id fallback
        }
      }
    }

    return {
      projectId: projectInfo.projectId,
      projectType: projectInfo.type,
      projectName,
      projectDir: projectInfo.projectDir,
    };
  }
}
