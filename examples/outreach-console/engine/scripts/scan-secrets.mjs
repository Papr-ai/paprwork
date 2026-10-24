#!/usr/bin/env node
// Fails if credential-shaped strings appear in source, examples or docs.
// Fixtures must use obviously fake values (see fixtureHint).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scanRoots = ['packages', 'apps', 'examples', 'scripts', 'docs'].map((dir) => join(root, dir));
const skipDirs = new Set(['node_modules', 'dist', 'coverage', '.git']);
const self = fileURLToPath(import.meta.url);

const patterns = [
  { name: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'slack_webhook', re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/g },
  { name: 'zoho_token', re: /\b1000\.[a-f0-9]{32}\.[a-f0-9]{32}\b/g },
  { name: 'github_token', re: /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g },
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai_key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'private_key', re: new RegExp(`BEGIN (?:RSA |EC |OPENSSH )?${['PRIVATE', 'KEY'].join(' ')}`, 'g') },
];

const fixtureHint = /example|fake|dummy|placeholder|fixture|redacted|xxxx/i;

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, acc);
    else if (stat.size <= 2_000_000) acc.push(full);
  }
  return acc;
}

const failures = [];
for (const scanRoot of scanRoots) {
  for (const file of walk(scanRoot)) {
    if (file === self) continue;
    const source = readFileSync(file, 'utf8');
    if (source.includes('\u0000')) continue;
    for (const { name, re } of patterns) {
      for (const match of source.match(re) ?? []) {
        if (fixtureHint.test(match)) continue;
        failures.push(`${relative(root, file)}: ${name} ${match.slice(0, 12)}…`);
      }
    }
  }
}

if (failures.length) {
  process.stderr.write(`Possible secrets found:\n${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('Secret scan ok.\n');
