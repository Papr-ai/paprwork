/**
 * Shared path validation for code indexing.
 * Only files inside ~/Papr/apps/{id}/ or ~/Papr/Jobs/{id}/ are indexable.
 */

import * as fs from 'fs';
import * as path from 'path';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py']);

export interface ProjectPathInfo {
  projectId: string;
  type: 'mini_app' | 'job';
  projectDir: string;
}

/**
 * Extract project info from a file path.
 * Returns null for loose files directly under apps/ or Jobs/ (e.g. Jobs/synthesis.py).
 */
export function getProjectPathInfo(filePath: string, paprDir: string): ProjectPathInfo | null {
  const parts = filePath.split(path.sep);
  const appsIndex = parts.indexOf('apps');
  const jobsIndex = parts.indexOf('Jobs');

  let container: 'apps' | 'Jobs' | null = null;
  let containerIndex = -1;

  if (appsIndex >= 0) {
    container = 'apps';
    containerIndex = appsIndex;
  } else if (jobsIndex >= 0) {
    container = 'Jobs';
    containerIndex = jobsIndex;
  } else {
    return null;
  }

  // Require apps/{projectId}/file — not a file sitting directly under apps/ or Jobs/
  if (containerIndex >= parts.length - 2) {
    return null;
  }

  const projectId = parts[containerIndex + 1];
  if (!projectId || path.extname(projectId)) {
    return null;
  }

  const projectDir = path.join(paprDir, container, projectId);
  try {
    if (!fs.statSync(projectDir).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    projectId,
    type: container === 'apps' ? 'mini_app' : 'job',
    projectDir,
  };
}

export function isIndexableCodePath(filePath: string, paprDir: string): boolean {
  const ext = path.extname(filePath);
  if (!CODE_EXTENSIONS.has(ext)) {
    return false;
  }
  return getProjectPathInfo(filePath, paprDir) !== null;
}

const PERMANENT_ERROR_PATTERNS = [
  'ENOTDIR',
  'Could not determine project ID',
  'File not in Jobs or apps folder',
  'not indexable',
  'Job not found:',
  'Mini-app not found:',
] as const;

export function isPermanentIndexError(message: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}
