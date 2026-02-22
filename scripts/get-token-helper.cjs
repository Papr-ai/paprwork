#!/usr/bin/env node
/**
 * Quick test: Get OPENAI_API_KEY from gateway process and test Codex API
 */

const { execSync } = require('child_process');

// Find gateway PID
const ps = execSync('ps aux | grep "dist/gateway/index.js" | grep -v grep').toString();
const pid = ps.split(/\s+/)[1];

console.log(`Gateway PID: ${pid}`);
console.log('\nTo test manually, run:');
console.log(`\n1. Get token from app logs (check [Agent WS] Fetched API key messages)`);
console.log(`2. Or extract from Electron main process memory (complex)`);
console.log(`\n3. Then run:`);
console.log(`   OPENAI_TOKEN="<token>" node scripts/test-codex-direct.mjs`);
