// Local dependency-free assertions for the minimal adapter follow-up only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'bundle'), app = join(bundle, 'apps/outreach-console');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const names = ['overview', 'approval-decide', 'task-outcome', 'review-resolve', 'campaign-pause', 'campaign-resume', 'kill-switch'];

test('ping answers a fixed status with an empty environment', () => {
  const run = spawnSync(process.execPath, [join(app, 'backend/ping.mjs')], { env: {}, encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0);
  assert.equal(run.stderr, '');
  assert.deepEqual(JSON.parse(run.stdout), { ok: true, data: { status: 'ready' } });
});
test('protected handler is unchanged and all seven actions fail closed without configuration', () => {
  assert.equal(createHash('sha256').update(readFileSync(join(app, 'backend/outreach.mjs'))).digest('hex'),
    '9e85b63c2246d0049935aa730c34dfb23a7c8b29949cdaf30637930d4d940e7b');
  for (const name of names) {
    const run = spawnSync(process.execPath, [join(app, 'backend/outreach.mjs')], {
      env: { PAPR_ACTION: name, PAPR_ACTION_PARAMS: '{}' }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(run.status, 1, name);
    assert.equal(JSON.parse(run.stdout).ok, false, name);
  }
});
test('app requirements exactly match server-only bundle declarations', () => {
  const manifest = json(join(bundle, 'manifest.json'));
  assert.deepEqual(json(join(app, 'requirements.json')), { schemaVersion: '1.0.0', requirements: manifest.requirements });
  assert.ok(manifest.requirements.every((key) => key.clientAccess === 'server'));
});
test('only the new startup action is key-free', () => {
  const actions = json(join(app, 'backend/manifest.json')).actions;
  assert.deepEqual(Object.keys(actions).sort(), ['ping', ...names].sort());
  assert.deepEqual(actions.ping, { handler: 'ping.mjs', runtime: 'node', keys: [], timeoutMs: 1000 });
  for (const name of names) {
    assert.deepEqual(actions[name], { handler: 'outreach.mjs', runtime: 'node', keys: ['OUTREACH_API_URL', 'OUTREACH_API_TOKEN'], timeoutMs: 15000 });
  }
});
test('job command addresses unchanged wrapper from job root and schedule stays disabled', () => {
  const job = json(join(bundle, 'manifest.json')).jobs[0];
  assert.equal(job.command, 'node code/run.mjs');
  assert.equal(job.entryPoint, 'code/run.mjs');
  assert.equal(job.schedule.enabled, false);
  assert.equal(job.schedule.catchUpMissed, false);
  assert.equal(createHash('sha256').update(readFileSync(join(bundle, 'jobs/outreach-worker/code/run.mjs'))).digest('hex'),
    '95785b9cced6fa10b8fb744ea6738c56db3f831e8416d007feccf9e894904054');
});
