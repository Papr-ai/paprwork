import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from './main';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'outreach-maintenance-')); dirs.push(dir);
  const env = { OUTREACH_PRINCIPAL: 'cli:tester', OUTREACH_DB: join(dir, 'outreach.db'), OUTREACH_WORKSPACE: 'demo' };
  const run = async (...args: string[]) => {
    let stdout = ''; let stderr = '';
    const code = await main(args, { env, write: (s) => { stdout += s; }, writeError: (s) => { stderr += s; } });
    return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
  };
  expect((await run('init', '--fake', '--json')).code).toBe(0);
  return { dir, run };
}
it('requires explicit backup configuration, dry runs without destination writes, and respects cadence', async () => {
  const { dir, run } = await fixture(); const destination = join(dir, 'backups');
  expect((await run('backup', '--json')).code).not.toBe(0);
  expect((await run('backup', '--backup-dir', destination, '--json')).code).not.toBe(0);
  const args = ['backup', '--backup-dir', destination, '--backup-every-hours', '24', '--json'];
  expect((await run(...args, '--dry-run')).json()).toMatchObject({ dryRun: true });
  expect(existsSync(destination)).toBe(false);
  expect((await run(...args)).json()).toMatchObject({ status: 'created' });
  expect((await run(...args)).json()).toMatchObject({ status: 'not_due' });
});
it('worker backups are opt-in and retention requires exact reviewed hash and exclusions acknowledgement', async () => {
  const { dir, run } = await fixture(); const destination = join(dir, 'backups');
  expect((await run('worker', '--once', '--fake', '--json')).code).toBe(0);
  expect(existsSync(destination)).toBe(false);
  expect((await run('worker', '--once', '--fake', '--backup-dir', destination, '--backup-every-hours', '24', '--json')).code).toBe(0);
  expect(existsSync(destination)).toBe(true);
  expect((await run('retention', 'preview', '--json')).code).not.toBe(0);
  const p = (await run('retention', 'preview', '--days', '30', '--json')).json();
  expect(p.counts).toEqual({ contacts: 0, points: 0, actions: 0, attempts: 0, messages: 0, events: 0, tasks: 0, imports: 0 });
  const args = ['retention', 'commit', String(p.id), '--confirm-hash', String(p.operationHash), '--json'];
  expect((await run(...args)).code).not.toBe(0);
  expect((await run(...args, '--acknowledge-exclusions')).json()).toEqual({ contacts: 0 });
  expect((await run(...args, '--acknowledge-exclusions')).code).not.toBe(0);
});
