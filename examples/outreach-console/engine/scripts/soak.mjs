#!/usr/bin/env node
// Multi-process soak (BUILD_PLAN.md §6.6, deferred from M3): N real `outreach worker` processes drain
// one SQLite file holding M due actions. Requires `npm run build`. Asserts every action was attempted
// exactly once, succeeded, and produced exactly one outbound message.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'packages/outreach-cli/dist/bin.js');
const WORKERS = Number(process.env.SOAK_WORKERS ?? 4);
const ACTIONS = Number(process.env.SOAK_ACTIONS ?? 10_000);
const dir = mkdtempSync(join(tmpdir(), 'outreach-soak-'));
const env = { ...process.env, OUTREACH_DB: join(dir, 'soak.db'), OUTREACH_WORKSPACE: 'soak', OUTREACH_PRINCIPAL: 'cli:soak', NODE_NO_WARNINGS: '1' };

function cli(...args) {
  const result = spawnSync(process.execPath, [bin, ...args, '--json'], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`outreach ${args.join(' ')} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function worker() {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [bin, 'worker', '--once', '--fake', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('close', (code) => (code === 0 ? resolveRun(JSON.parse(out)) : reject(new Error(`worker exited ${code}:\n${err}`))));
  });
}

try {
  cli('init', '--fake');
  const { providerAccountId } = cli('account', 'add', '--fake', '--provider', 'fake-email', '--external-id', 'soak@example.com', '--sender-name', 'Soak',
    '--sender-email', 'soak@example.com', '--purposes', 'automated_outreach', '--secret', 'env:SOAK_SECRET');
  cli('jurisdiction', 'set', '--default', 'allow', '--unknown', 'allow', '--signed-off-by', 'soak', '--reference', 'fake providers only');
  cli('gate', 'open', '--reason', 'soak test against fake providers only');

  const { openSqliteDatabase } = await import(join(root, 'packages/outreach-store-sqlite/dist/index.js'));
  const { enqueueAction } = await import(join(root, 'packages/outreach-core/dist/index.js'));
  const db = openSqliteDatabase(env.OUTREACH_DB);
  const now = Date.now();
  const actor = { kind: 'system', id: 'soak', source: 'soak', traceId: 'soak' };
  db.transaction(() => {
    for (let i = 0; i < ACTIONS; i += 1) {
      enqueueAction(db, {
        workspaceId: 'soak', kind: 'email.send', providerAccountId, purpose: 'automated_outreach', recipient: `r${i}@example.org`,
        idempotencyKey: `soak:${i}`, dueAt: now - 1_000, senderDomain: 'example.com',
        payload: { from: { address: 'soak@example.com' }, to: [{ address: `r${i}@example.org` }], subject: `Soak ${i}`, text: 'x', headers: {} },
      }, actor, now);
    }
  });
  db.close();

  // Each `worker --once` pass executes at most 500 actions, so run rounds of concurrent workers until drained.
  const started = performance.now();
  const executedPerWorker = Array.from({ length: WORKERS }, () => 0);
  let rounds = 0;
  for (;;) {
    rounds += 1;
    const reports = await Promise.all(Array.from({ length: WORKERS }, worker));
    reports.forEach((report, i) => (executedPerWorker[i] += report.execute.executed));
    if (reports.every((report) => report.execute.claimed === 0) || rounds > 100) break;
  }
  const settle = await worker();
  const elapsed = Math.round(performance.now() - started);

  const check = openSqliteDatabase(env.OUTREACH_DB, { migrate: false });
  const count = (sql) => check.prepare(sql).get().n;
  const results = {
    workers: WORKERS,
    actions: ACTIONS,
    elapsedMs: elapsed,
    rounds,
    executedPerWorker,
    settlePassExecuted: settle.execute.executed,
    succeeded: count(`SELECT COUNT(*) AS n FROM scheduled_actions WHERE state = 'succeeded'`),
    actionsWithMultipleAttempts: count(`SELECT COUNT(*) AS n FROM (SELECT action_id FROM action_attempts GROUP BY action_id HAVING COUNT(*) > 1)`),
    attempts: count(`SELECT COUNT(*) AS n FROM action_attempts`),
    outboundMessages: count(`SELECT COUNT(DISTINCT action_id) AS n FROM messages WHERE direction = 'outbound'`),
  };
  check.close();
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  const ok = results.succeeded === ACTIONS && results.actionsWithMultipleAttempts === 0 && results.attempts === ACTIONS && results.outboundMessages === ACTIONS;
  const sharedWork = results.executedPerWorker.filter((n) => n > 0).length >= Math.min(2, WORKERS);
  if (!ok) throw new Error('soak invariants violated');
  if (!sharedWork) throw new Error('workers did not run concurrently; the soak proved nothing');
  process.stdout.write('Soak ok: every action attempted exactly once across concurrent worker processes.\n');
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
