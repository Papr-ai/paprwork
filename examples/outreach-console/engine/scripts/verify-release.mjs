#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { verifyRelease } from './release-manifest.mjs';
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--allow-unreleased')) throw new Error('Only --allow-unreleased is accepted');
const packages = verifyRelease({ allowUnreleased: args.includes('--allow-unreleased'), ...(process.env.RELEASE_TAG ? { tag: process.env.RELEASE_TAG } : {}) });
for (const pkg of packages) {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkg.path, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`pack failed: ${pkg.name}\n${result.stderr}`);
  const files = JSON.parse(result.stdout)[0].files.map((file) => file.path);
  if (files.some((name) => /(^|\/)(\.env|node_modules|.*\.db(?:-wal|-shm)?$)/.test(name))) throw new Error(`Unsafe package files: ${pkg.name}`);
  for (const name of ['README.md', 'LICENSE']) if (!files.includes(name)) throw new Error(`Package excludes ${name}: ${pkg.name}`);
  console.log(`${pkg.name}@${pkg.version}: pack verified (${files.length} files)`);
}
