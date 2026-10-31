import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyEngineSnapshot } from '../scripts/verify-engine-snapshot.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path));
const json = (path) => JSON.parse(read(path));

test('includes every pinned engine source file byte-for-byte without generated extras', () => {
  assert.deepEqual(verifyEngineSnapshot(), { files: 272, bytes: 1228930 });
});

test('retains the complete separate workspace, internal lockfile links and original notices', () => {
  const pkg = json('engine/package.json');
  assert.deepEqual(pkg.workspaces, ['packages/*', 'apps/*']);
  assert.equal(readdirSync(join(root, 'engine/packages')).length, 13);
  const lock = json('engine/package-lock.json');
  const links = Object.values(lock.packages).filter((value) => value.link);
  assert.equal(links.length, 14);
  for (const link of links) assert.match(link.resolved, /^(packages|apps)\/[a-z0-9-]+$/);
  assert.deepEqual(read('engine/LICENSE'), read('LICENSE'));
  let packageNotices = 0;
  for (const name of readdirSync(join(root, 'engine/packages'))) {
    assert.equal(json(`engine/packages/${name}/package.json`).license, 'MIT');
    const license = `engine/packages/${name}/LICENSE`;
    if (existsSync(join(root, license))) {
      assert.equal(read(license).toString().trim(), read('LICENSE').toString().trim());
      packageNotices++;
    } else {
      assert.equal(name, 'outreach-e2e'); // Private source package covered by engine/LICENSE.
    }
  }
  assert.equal(packageNotices, 12); // Exact original bytes are enforced by the snapshot verifier.
});

test('preserves runtime parity except the three documented outer bundle corrections', () => {
  const original = 'engine/apps/papr/bundle';
  function paths(dir, prefix = '') {
    return readdirSync(join(root, dir, prefix), { withFileTypes: true }).flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? paths(dir, path) : [path];
    });
  }
  const changes = new Set(['manifest.json', 'apps/outreach-console/backend/manifest.json']);
  const additions = ['apps/outreach-console/backend/ping.mjs', 'apps/outreach-console/requirements.json'];
  for (const path of paths(original)) {
    if (!changes.has(path)) assert.deepEqual(read(`${original}/${path}`), read(`bundle/${path}`), path);
  }
  assert.deepEqual(paths('bundle').sort(), [...paths(original), ...additions].sort());
  const before = json(`${original}/manifest.json`);
  const after = json('bundle/manifest.json');
  before.jobs[0].command = 'node code/run.mjs';
  assert.match(before.deploymentProfiles[0].notes, /in the job environment/);
  before.deploymentProfiles[0].notes = 'Desktop-only pilot. Keep publishing and the job schedule disabled. Configure absolute OUTREACH_CLI_ENTRY and OUTREACH_DB in the trusted local Papr gateway process environment; bundle job env metadata is not applied by the pinned importer. Verify local execution before enabling scheduling.';
  assert.deepEqual(before, after);
  const backendBefore = json(`${original}/apps/outreach-console/backend/manifest.json`);
  const backendAfter = json('bundle/apps/outreach-console/backend/manifest.json');
  delete backendAfter.actions.ping;
  assert.deepEqual(backendBefore, backendAfter);
});
