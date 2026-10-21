#!/usr/bin/env node
// BUILD_PLAN.md §3: at most 400 significant lines per TypeScript file
// (Papr Work's 500-line rule with headroom). Blank and comment-only lines do not count.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX = 400;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skipDirs = new Set(['node_modules', 'dist', 'coverage']);

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

function significantLines(source) {
  let count = 0;
  let inBlock = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line === '' || line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    count += 1;
  }
  return count;
}

const offenders = [];
for (const group of ['packages', 'apps']) {
  for (const file of walk(join(root, group))) {
    const lines = significantLines(readFileSync(file, 'utf8'));
    if (lines > MAX) offenders.push(`${relative(root, file)}: ${lines} lines (max ${MAX})`);
  }
}

if (offenders.length) {
  process.stderr.write(`Files over the line limit:\n${offenders.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Line limit ok (max ${MAX}).\n`);
