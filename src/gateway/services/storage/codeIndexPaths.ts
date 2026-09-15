/**
 * Shared path validation for code indexing.
 * Only files inside ~/Papr/apps/{id}/ or ~/Papr/jobs/{id}/ are indexable.
 */

import * as fs from 'fs';
import * as path from 'path';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py']);

/**
 * Canonical identity for an indexed file.
 *
 * WHY: the index key was the raw path string, so the SAME file on disk could
 * be indexed several times under different spellings, and each copy paid for
 * its own LLM enrichment:
 *
 *   - case-variant roots — ~/Papr/... vs ~/PAPR/... (macOS/APFS is
 *     case-INSENSITIVE, so both resolve to one inode)
 *   - symlinked or /private-prefixed paths on macOS
 *
 * Measured in the pre-namespace code-index DB: 727 rows for 534 distinct
 * files — 193 files (36%) stored under two spellings, e.g.
 * `PAPR/Jobs/.../main.py` and `Papr/Jobs/.../main.py` as separate rows with
 * separate memory ids.
 *
 * realpathSync.native asks the filesystem for the true on-disk spelling, which
 * collapses every variant onto one canonical path WITHOUT lowercasing — so the
 * value stays correct on case-SENSITIVE volumes, where Papr and PAPR really
 * are two different directories and must stay distinct. Lowercasing would
 * corrupt those.
 *
 * Falls back to path.resolve when the file does not exist yet (deleted
 * entries, queued-then-removed files) so callers always get an absolute path.
 */
export function normalizeIndexPath(filePath: string): string {
  if (!filePath) return filePath;
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

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
