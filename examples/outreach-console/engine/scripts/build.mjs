#!/usr/bin/env node
// Builds workspace packages in dependency order. npm's --workspaces order is alphabetical, which built
// @splitin/outreach-cli before the packages whose type declarations it needs (a clean CI checkout failed).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = new Map();
for (const group of ['packages', 'apps']) {
  const base = join(root, group);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base)) {
    const file = join(base, name, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
    packages.set(pkg.name, { deps, build: Boolean(pkg.scripts?.build) });
  }
}

const order = [];
const state = new Map();
function visit(name, trail) {
  if (state.get(name) === 'done') return;
  if (state.get(name) === 'visiting') throw new Error(`dependency cycle: ${[...trail, name].join(' -> ')}`);
  state.set(name, 'visiting');
  for (const dep of packages.get(name).deps) if (packages.has(dep)) visit(dep, [...trail, name]);
  state.set(name, 'done');
  order.push(name);
}
for (const name of [...packages.keys()].sort()) visit(name, []);

for (const name of order.filter((n) => packages.get(n).build)) {
  process.stdout.write(`\n> building ${name}\n`);
  execFileSync('npm', ['run', 'build', '--workspace', name], { cwd: root, stdio: 'inherit' });
}
