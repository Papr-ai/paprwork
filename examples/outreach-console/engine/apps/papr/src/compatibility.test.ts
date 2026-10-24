import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'bundle');
const read = (path: string): string => readFileSync(join(bundle, path), 'utf8');
const provenance = JSON.parse(readFileSync(join(root, 'compatibility.json'), 'utf8')) as {
  checkedAgainst: { commit: string }; fullHostValidation: string;
};
const manifest = JSON.parse(read('manifest.json')) as {
  jobs: Array<{ schedule: { enabled: boolean } }>;
  sync: { cloudReady: boolean };
  deploymentProfiles: Array<{ runtimeTarget: string }>;
};
function sources(dir = 'apps/outreach-console'): Array<{ path: string; source: string }> {
  return readdirSync(join(bundle, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.name === 'backend') return [];
    if (entry.isDirectory()) return sources(path);
    return /\.(js|html|css)$/.test(entry.name) ? [{ path, source: read(path) }] : [];
  });
}
// Reproduce the documented significant-line counting convention, not AppService execution.
function significantLines(source: string): number {
  let count = 0, block = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('/*')) block = true;
    if (block) { if (line.includes('*/')) block = false; continue; }
    if (!line.startsWith('//')) count++;
  }
  return count;
}

describe('Papr compatibility guardrails', () => {
  it('records its exact contract baseline without claiming runtime acceptance', () => {
    expect(provenance.checkedAgainst.commit).toBe('b34b6c4090adfb64109004d1a25645a3d3a2bd66');
    expect(provenance.fullHostValidation).toBe('pending');
  });
  it('declares local-only intent and leaves all schedules disabled', () => {
    expect(manifest.sync.cloudReady).toBe(false);
    expect(manifest.deploymentProfiles.every((p) => p.runtimeTarget === 'local')).toBe(true);
    expect(manifest.jobs.every((job) => !job.schedule.enabled)).toBe(true);
  });
  it('keeps every frontend source within the 100 significant-line guideline', () => {
    for (const file of sources()) expect(significantLines(file.source), file.path).toBeLessThanOrEqual(100);
  });
  it('has no blocked native dialog calls or browser Node imports', () => {
    for (const file of sources().filter((f) => f.path.endsWith('.js'))) {
      expect(file.source, file.path).not.toMatch(/\b(?:window\.)?(?:prompt|confirm|alert)\s*\(/);
      expect(file.source, file.path).not.toMatch(/(?:from\s*|import\s*\()\s*['"]node:/);
    }
  });
  it('ships every relative import in the split frontend', () => {
    for (const file of sources().filter((f) => f.path.endsWith('.js'))) {
      for (const match of file.source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g)) {
        expect(() => readFileSync(join(bundle, dirname(file.path), match[1]!)), file.path).not.toThrow();
      }
    }
  });
});
