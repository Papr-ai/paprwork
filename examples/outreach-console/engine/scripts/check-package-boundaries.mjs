#!/usr/bin/env node
// Enforces the dependency direction in BUILD_PLAN.md §3:
// contracts ← everything; core, import and adapters depend on contracts only;
// only the surfaces (server, mcp, cli, apps) may compose packages freely.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INTERNAL = /^@splitin\/outreach-[a-z0-9-]+$/;
const ANY = '*';

// Internal packages each package may depend on. A package missing from this table fails the check,
// so every new package must declare its place in the graph.
const internalRules = [
  [/^@splitin\/outreach-contracts$/, []],
  [/^@splitin\/outreach-fakes$/, ['@splitin/outreach-contracts']],
  [/^@splitin\/outreach-store-sqlite$/, ['@splitin/outreach-contracts']],
  [/^@splitin\/outreach-core$/, ['@splitin/outreach-contracts']],
  [/^@splitin\/outreach-import$/, ['@splitin/outreach-contracts']],
  [/^@splitin\/outreach-notify-[a-z0-9-]+$/, ['@splitin/outreach-contracts', '@splitin/outreach-provider-kit']],
  [/^@splitin\/outreach-provider-kit$/, ['@splitin/outreach-contracts']],
  [/^@splitin\/outreach-provider-[a-z0-9-]+$/, ['@splitin/outreach-contracts', '@splitin/outreach-provider-kit']],
  [/^@splitin\/outreach-(server|mcp|cli)$/, ANY],
  [/^@splitin\/outreach-app-[a-z0-9-]+$/, ANY],
  [/^@splitin\/outreach-e2e$/, ANY],
];

// External modules that only specific packages may import.
const externalOwners = [
  [/^(node:sqlite|better-sqlite3)$/, /^@splitin\/outreach-store-sqlite$/],
  [/^(hono|@hono\/.+)$/, /^@splitin\/outreach-(server|mcp)$/],
  [/^@modelcontextprotocol\/.+$/, /^@splitin\/outreach-mcp$/],
  [/^@slack\/.+$/, /^@splitin\/outreach-notify-slack$/],
  [/^(csv-parse|exceljs|parse5)(\/.*)?$/, /^@splitin\/outreach-import$/],
];

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function packageDirs() {
  const dirs = [];
  for (const group of ['packages', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (existsSync(join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs;
}

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

function allowedInternal(name) {
  const rule = internalRules.find(([pattern]) => pattern.test(name));
  return rule ? rule[1] : null;
}

const violations = [];
const dirs = packageDirs();

for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const name = pkg.name;
  const rel = relative(root, dir);
  const allowed = allowedInternal(name);
  if (allowed === null) {
    violations.push(`${rel}: package "${name}" has no boundary rule; add it to scripts/check-package-boundaries.mjs`);
    continue;
  }
  const permits = (dep) => allowed === ANY || allowed.includes(dep);

  const declared = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
  for (const dep of Object.keys(declared)) {
    if (INTERNAL.test(dep) && !permits(dep)) violations.push(`${rel}/package.json: ${name} may not depend on ${dep}`);
  }

  const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));
  for (const file of sourceFiles(join(dir, 'src'))) {
    const fileRel = relative(root, file);
    // Tests may compose any workspace package declared in devDependencies (fakes, store).
    const isTest = /\.test(-util)?\.[cm]?[jt]sx?$/.test(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec);
        if (target !== dir && !target.startsWith(dir + sep)) {
          violations.push(`${fileRel}: relative import "${spec}" escapes its package; import the package by name`);
        }
        continue;
      }
      const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec;
      if (INTERNAL.test(bare)) {
        if (bare !== name && !permits(bare) && !(isTest && devDeps.has(bare))) violations.push(`${fileRel}: ${name} may not import ${bare}`);
        continue;
      }
      for (const [modulePattern, ownerPattern] of externalOwners) {
        if (modulePattern.test(spec) && !ownerPattern.test(name)) {
          violations.push(`${fileRel}: "${spec}" may only be imported by packages matching ${ownerPattern}`);
        }
      }
    }
  }
}

if (violations.length) {
  process.stderr.write(`Package boundary violations:\n${violations.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Package boundaries ok (${dirs.length} package${dirs.length === 1 ? '' : 's'}).\n`);
