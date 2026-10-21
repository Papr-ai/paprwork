import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const path = join(dirname(fileURLToPath(import.meta.url)), '../bundle/jobs/outreach-worker/code/run.mjs');
interface WorkerResult { ok: boolean; exitCode: number; error?: string }
type Env = Record<string, string>;
const { runWorker, workerCommand } = await import(path) as {
  runWorker: (env: Env, signal?: AbortSignal) => Promise<WorkerResult>;
  workerCommand: (env: Env) => { args: string[]; env: Env; timeoutMs: number };
};
let dir: string, entry: string, env: Env;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'papr-worker-test-'));
  entry = join(dir, 'fake-cli.mjs');
  writeFileSync(entry, 'process.exit(0);\n');
  writeFileSync(join(dir, 'outreach.db'), 'fake-db');
  env = { OUTREACH_CLI_ENTRY: entry, OUTREACH_HOME: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('optional local worker wrapper', () => {
  it.each(['', './cli.js', 'https://example.org/cli.js', 'file:///tmp/cli.js', '/tmp/cli.js\n--eval=x', '/tmp/cli.js\0'])('rejects missing, relative and nonlocal entry %s', async (candidate) => {
    const result = await runWorker({ ...env, OUTREACH_CLI_ENTRY: candidate });
    expect(result).toMatchObject({ ok: false, exitCode: 2 });
    expect(result.error).not.toContain(candidate || 'https:');
  });
  it('rejects directories and symlink entry files', async () => {
    const link = join(dir, 'linked.js'); symlinkSync(entry, link);
    expect((await runWorker({ ...env, OUTREACH_CLI_ENTRY: dir })).exitCode).toBe(2);
    expect((await runWorker({ ...env, OUTREACH_CLI_ENTRY: link })).exitCode).toBe(2);
  });
  it('requires an existing regular database and bounded timeout', async () => {
    const cases: Env[] = [{ OUTREACH_DB: 'relative.db' }, { OUTREACH_DB: dir }, { OUTREACH_DB: join(dir, 'missing.db') }, { OUTREACH_WORKER_TIMEOUT_MS: '0' }, { OUTREACH_WORKER_TIMEOUT_MS: '300001' }];
    for (const patch of cases) {
      expect((await runWorker({ ...env, ...patch })).exitCode).toBe(2);
    }
  });
  it('uses exact one-pass argv, optional trusted config and no request-derived entry', () => {
    writeFileSync(join(dir, 'outreach.config.mjs'), 'export default {};');
    const command = workerCommand({ ...env, PAPR_ACTION_PARAMS: JSON.stringify({ OUTREACH_CLI_ENTRY: 'attacker.js' }) });
    expect(command.args).toEqual([entry, 'worker', '--once', '--json', '--config', join(dir, 'outreach.config.mjs')]);
    expect(command.env.OUTREACH_DB).toBe(join(dir, 'outreach.db'));
  });
  it('passes shell metacharacters as a single local filename, never as commands', async () => {
    const output = join(dir, 'observed.json'), injected = join(dir, 'injected');
    const unusual = join(dir, 'fake cli;echo injected.mjs');
    writeFileSync(unusual, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2)));`);
    expect(await runWorker({ ...env, OUTREACH_CLI_ENTRY: unusual })).toEqual({ ok: true, exitCode: 0 });
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(['worker', '--once', '--json']);
    expect(existsSync(injected)).toBe(false);
    expect((await runWorker({ ...env, OUTREACH_CLI_ENTRY: `${entry};touch ${injected}` })).exitCode).toBe(2);
  });
  it('returns nonzero child status without leaking stderr or stdout', async () => {
    writeFileSync(entry, "console.error('secret-token-value');console.log('private-provider-data');process.exit(7);");
    const result = await runWorker(env);
    expect(result).toMatchObject({ ok: false, exitCode: 7 });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|private-provider/);
  });
  it('does not launch when already cancelled', async () => {
    const marker = join(dir, 'launched');
    writeFileSync(entry, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'yes');`);
    const abort = new AbortController(); abort.abort();
    expect(await runWorker(env, abort.signal)).toMatchObject({ ok: false, exitCode: 130 });
    expect(existsSync(marker)).toBe(false);
  });
  it('terminates a running child on cancellation and timeout', async () => {
    writeFileSync(entry, 'setInterval(() => {}, 1000);');
    const abort = new AbortController();
    const pending = runWorker(env, abort.signal);
    setTimeout(() => abort.abort(), 80);
    expect(await pending).toMatchObject({ ok: false, exitCode: 130 });
    expect(await runWorker({ ...env, OUTREACH_WORKER_TIMEOUT_MS: '100' })).toMatchObject({ ok: false, exitCode: 124 });
  });
  it('forwards subprocess SIGTERM to the running child before exiting', async () => {
    const pidFile = join(dir, 'child.pid');
    writeFileSync(entry, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(() => {}, 1000);`);
    const child = spawn(process.execPath, [path], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!existsSync(pidFile)) { child.kill('SIGKILL'); await closed; throw new Error('Fake child did not start'); }
    const pid = Number(readFileSync(pidFile, 'utf8'));
    child.kill('SIGTERM');
    expect(await closed).toBe(130);
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('runs as a real job subprocess with redacted JSON diagnostics', async () => {
    writeFileSync(entry, "console.error('secret-token-value');process.exit(7);");
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    expect(result.code).toBe(7); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, exitCode: 7 });
    expect(result.stdout).not.toContain('secret-token');
  });
});
