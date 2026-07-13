/**
 * LLM-powered summaries for indexed code files and projects.
 */

import * as path from 'path';
import { generateCheapSummaryText } from '../../utils/cheapSummarizerModel.js';

const FILE_SUMMARY_SYSTEM = `You summarize source code files for a developer assistant.
Write 3-5 concise sentences covering:
- What the file does (primary responsibility)
- Key exports, components, or entry points
- Important dependencies or data sources
- Notable patterns or gotchas

Rules:
- No markdown headers or bullet lists
- Plain prose only
- Do not invent functionality not present in the code
- Mention file name once at the start`;

const PROJECT_OVERVIEW_SYSTEM = `You synthesize a project overview from per-file summaries.
Write a cohesive overview in 6-10 sentences covering:
- What the project/app/job does end-to-end
- Main modules and how they connect
- Data sources, APIs, or external integrations
- Entry points and execution flow

Rules:
- No markdown headers or bullet lists
- Plain prose only
- Base your answer ONLY on the provided file summaries
- Do not invent files or features`;

const MAX_FILE_CHARS = 12000;

export class CodeSummaryGenerator {
  async generateFileSummary(input: {
    filePath: string;
    fileName: string;
    language: string;
    content: string;
    projectName: string;
    projectType: 'mini_app' | 'job';
  }): Promise<string | null> {
    const truncated = input.content.length > MAX_FILE_CHARS
      ? `${input.content.slice(0, MAX_FILE_CHARS)}\n\n... (truncated for summarization)`
      : input.content;

    const userPrompt = [
      `Project: ${input.projectName} (${input.projectType})`,
      `File: ${input.fileName}`,
      `Path: ${input.filePath}`,
      `Language: ${input.language}`,
      '',
      'Source code:',
      truncated,
    ].join('\n');

    return generateCheapSummaryText(FILE_SUMMARY_SYSTEM, userPrompt, 400);
  }

  async generateProjectOverview(input: {
    projectId: string;
    projectName: string;
    projectType: 'mini_app' | 'job';
    fileSummaries: Array<{ fileName: string; relativePath: string; summary: string }>;
  }): Promise<string | null> {
    if (input.fileSummaries.length === 0) {
      return `Project ${input.projectName} (${input.projectId}) has no indexed source files yet.`;
    }

    const filesBlock = input.fileSummaries
      .map((file) => `### ${file.relativePath}\n${file.summary}`)
      .join('\n\n');

    const userPrompt = [
      `Project: ${input.projectName}`,
      `ID: ${input.projectId}`,
      `Type: ${input.projectType}`,
      `Files summarized: ${input.fileSummaries.length}`,
      '',
      'Per-file summaries:',
      filesBlock,
    ].join('\n');

    return generateCheapSummaryText(PROJECT_OVERVIEW_SYSTEM, userPrompt, 700);
  }

  detectLanguage(ext: string): string {
    const map: Record<string, string> = {
      '.ts': 'TypeScript',
      '.tsx': 'TypeScript',
      '.js': 'JavaScript',
      '.jsx': 'JavaScript',
      '.py': 'Python',
    };
    return map[ext] || 'Unknown';
  }

  toRelativePath(filePath: string, projectDir: string): string {
    const relative = path.relative(projectDir, filePath);
    return relative || path.basename(filePath);
  }
}
