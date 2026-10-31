import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function releaseManifest() {
  const packages = new Map();
  for (const dir of readdirSync(resolve(root, 'packages'))) {
    const path = resolve(root, 'packages', dir);
    const pkg = JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8'));
    if (!pkg.private) packages.set(pkg.name, { ...pkg, path });
  }
  const sorted = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(pkg) {
    if (visited.has(pkg.name)) return;
    if (visiting.has(pkg.name)) throw new Error(`Package cycle: ${pkg.name}`);
    visiting.add(pkg.name);
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (!name.startsWith('@splitin/outreach-')) continue;
      const dep = packages.get(name);
      if (!dep || version !== dep.version) throw new Error(`${pkg.name}: internal dependency ${name}@${version} is missing or mismatched`);
      visit(dep);
    }
    visiting.delete(pkg.name);
    visited.add(pkg.name);
    sorted.push(pkg);
  }
  for (const pkg of packages.values()) visit(pkg);
  return sorted;
}
export function verifyRelease({ allowUnreleased = false, tag } = {}) {
  const packages = releaseManifest();
  const versions = new Set(packages.map((p) => p.version));
  if (versions.size !== 1) throw new Error('All public packages must have one coordinated version');
  const version = packages[0]?.version;
  if (!version || (!allowUnreleased && version === '0.0.0')) throw new Error('Assign a release version before publishing; 0.0.0 is development-only');
  if (tag !== undefined && tag !== `outreach-engine-v${version}`) throw new Error('Release tag does not match package version');
  for (const pkg of packages) {
    for (const entry of [pkg.main, pkg.module, pkg.types, ...Object.values(pkg.bin ?? {})]) {
      if (entry && !existsSync(resolve(pkg.path, entry))) throw new Error(`Missing build entry: ${pkg.name} ${entry}`);
    }
    if (!existsSync(resolve(pkg.path, 'README.md'))) throw new Error(`Missing package README: ${pkg.name}`);
    if (!existsSync(resolve(pkg.path, 'LICENSE'))) throw new Error(`Missing package license: ${pkg.name}`);
  }
  return packages;
}
