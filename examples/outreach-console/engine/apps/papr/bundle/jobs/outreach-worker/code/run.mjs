// Local-only, dependency-free wrapper. Configure the trusted built CLI path in the
// Papr job environment. No path or command comes from app requests or model text.
/* global setTimeout, clearTimeout, AbortController */
import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

function regularFile(path) {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

export function workerCommand(env) {
  const entry = env.OUTREACH_CLI_ENTRY ?? '';
  if (!isAbsolute(entry) || /[\0\r\n]/.test(entry) || !/\.(?:mjs|cjs|js)$/i.test(entry) || !regularFile(entry)) {
    throw new Error('Set OUTREACH_CLI_ENTRY to a trusted absolute regular local file: packages/outreach-cli/dist/bin.js.');
  }
  const home = env.OUTREACH_HOME ?? join(env.PAPR_HOME ?? join(homedir(), 'Papr'), 'outreach');
  const db = env.OUTREACH_DB ?? join(home, 'outreach.db');
  if (!isAbsolute(db) || !regularFile(db)) throw new Error('Set OUTREACH_DB to an existing absolute database file; run outreach init first.');
  const timeoutMs = Number(env.OUTREACH_WORKER_TIMEOUT_MS ?? 120000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('OUTREACH_WORKER_TIMEOUT_MS must be 100–300000 milliseconds.');
  const config = join(home, 'outreach.config.mjs');
  const args = [entry, 'worker', '--once', '--json', ...(existsSync(config) ? ['--config', config] : [])];
  return { args, env: { ...env, OUTREACH_DB: db }, timeoutMs };
}

export async function runWorker(env, signal) {
  let command;
  try { command = workerCommand(env); } catch (error) { return { ok: false, exitCode: 2, error: error.message }; }
  if (signal?.aborted) return { ok: false, exitCode: 130, error: 'Worker cancelled.' };
  return new Promise((resolve) => {
    // Deliberately suppress child output: it may contain provider data or secrets.
    const child = spawn(process.execPath, command.args, { env: command.env, shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
    let reason = '', settled = false, forceTimer;
    function stop(why) {
      if (settled || reason) return;
      reason = why;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      forceTimer.unref();
    }
    const cancel = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed out'), command.timeoutMs);
    function finish(code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', cancel);
      const exitCode = reason === 'timed out' ? 124 : reason ? 130 : code;
      resolve(exitCode === 0 ? { ok: true, exitCode } : { ok: false, exitCode, error: reason ? `Worker ${reason}.` : `Worker exited with code ${exitCode}; inspect the engine's local diagnostics.` });
    }
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.once('error', () => finish(1));
    child.once('close', (code) => finish(code ?? 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  const result = await runWorker(process.env, controller.signal);
  console.log(JSON.stringify(result));
  process.exitCode = result.exitCode;
}
