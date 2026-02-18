#!/usr/bin/env node
/**
 * Run Agent Performance Tests
 * 
 * Usage:
 *   npm run test:perf
 *   npm run test:perf -- --watch
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Run vitest with the performance test
const args = [
  'vitest',
  'run',
  'tests/agent-performance-scaling.test.ts',
  '--config',
  'vitest.config.integration.ts',
  ...process.argv.slice(2), // Pass through any CLI args
];

console.log('🚀 Running Agent Performance Tests...\n');
console.log('This will:');
console.log('  1. Measure latency across 20 messages');
console.log('  2. Identify bottleneck components');
console.log('  3. Show session caching benefits\n');
console.log('Note: Requires OPENAI_API_KEY in .env.local for live tests\n');
console.log('─'.repeat(80));

const child = spawn('npx', args, {
  cwd: rootDir,
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    NODE_ENV: 'test',
  },
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
