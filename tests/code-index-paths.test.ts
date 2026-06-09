import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getProjectPathInfo,
  isIndexableCodePath,
  isPermanentIndexError,
} from '../src/gateway/services/storage/codeIndexPaths.js';

const paprDir = path.join(os.homedir(), 'Papr');

describe('codeIndexPaths', () => {
  it('rejects loose files directly under Jobs/', () => {
    const filePath = path.join(paprDir, 'Jobs', 'synthesis.py');
    expect(isIndexableCodePath(filePath, paprDir)).toBe(false);
    expect(getProjectPathInfo(filePath, paprDir)).toBeNull();
  });

  it('accepts files inside a job project folder when present', () => {
    const jobsDir = path.join(paprDir, 'Jobs');
    if (!fs.existsSync(jobsDir)) {
      return;
    }

    const jobId = fs.readdirSync(jobsDir).find((entry) => {
      const fullPath = path.join(jobsDir, entry);
      return fs.statSync(fullPath).isDirectory();
    });

    if (!jobId) {
      return;
    }

    const filePath = path.join(jobsDir, jobId, 'code', 'main.py');
    if (!fs.existsSync(filePath)) {
      return;
    }

    const info = getProjectPathInfo(filePath, paprDir);
    expect(info).not.toBeNull();
    expect(info?.type).toBe('job');
    expect(info?.projectId).toBe(jobId);
    expect(isIndexableCodePath(filePath, paprDir)).toBe(true);
  });

  it('classifies permanent indexing errors', () => {
    expect(isPermanentIndexError('ENOTDIR: not a directory, scandir')).toBe(true);
    expect(isPermanentIndexError('Could not determine project ID')).toBe(true);
    expect(isPermanentIndexError('network timeout')).toBe(false);
  });
});
