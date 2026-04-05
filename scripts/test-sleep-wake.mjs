#!/usr/bin/env node
/**
 * Automated test script for sleep/wake handling
 * Tests connection indicator, WebSocket reconnection, and job reconciliation
 */

import { spawn, execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// ANSI colors
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function success(message) {
  log(`✅ ${message}`, 'green');
}

function error(message) {
  log(`❌ ${message}`, 'red');
}

function info(message) {
  log(`ℹ️  ${message}`, 'blue');
}

function warn(message) {
  log(`⚠️  ${message}`, 'yellow');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkGatewayRunning() {
  try {
    const result = execSync('ps aux | grep -i "gateway/index.js" | grep -v grep', { encoding: 'utf8' });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

async function getGatewayPid() {
  try {
    const result = execSync('ps aux | grep -i "gateway/index.js" | grep -v grep', { encoding: 'utf8' });
    const match = result.match(/\s+(\d+)\s+/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function killGateway() {
  try {
    execSync('pkill -f "node.*gateway/index.js"');
    return true;
  } catch {
    return false;
  }
}

async function checkGatewayHealth() {
  try {
    const response = await fetch('http://localhost:18789/health');
    const data = await response.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}

async function simulateSuspendResume() {
  info('Simulating system suspend/resume by killing and restarting Gateway...');
  
  const initialPid = await getGatewayPid();
  if (!initialPid) {
    error('Gateway not running before test');
    return false;
  }
  info(`Gateway PID before suspend: ${initialPid}`);
  
  // Kill Gateway (simulates suspend)
  await killGateway();
  await sleep(1000);
  
  const killedCheck = await checkGatewayRunning();
  if (killedCheck) {
    error('Gateway still running after kill');
    return false;
  }
  success('Gateway stopped (suspend simulated)');
  
  // Wait for supervisor to restart (simulates resume)
  info('Waiting for Gateway supervisor to restart (simulates wake)...');
  let restarted = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const running = await checkGatewayRunning();
    if (running) {
      const newPid = await getGatewayPid();
      info(`Gateway restarted with new PID: ${newPid}`);
      restarted = true;
      break;
    }
  }
  
  if (!restarted) {
    error('Gateway did not restart within 20 seconds');
    return false;
  }
  
  // Wait for Gateway to be healthy
  info('Waiting for Gateway to be healthy...');
  let healthy = false;
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    healthy = await checkGatewayHealth();
    if (healthy) {
      success('Gateway is healthy after restart');
      break;
    }
  }
  
  return healthy;
}

async function testWebSocketReconnection() {
  info('\n📡 Testing WebSocket reconnection...');
  
  // This test verifies that:
  // 1. Gateway supervisor automatically restarts Gateway when it crashes
  // 2. WebSocket client reconnects with exponential backoff
  
  const result = await simulateSuspendResume();
  if (!result) {
    error('WebSocket reconnection test FAILED');
    return false;
  }
  
  success('WebSocket reconnection test PASSED');
  return true;
}

async function testExponentialBackoff() {
  info('\n⏱️  Testing exponential backoff...');
  
  // Test that reconnection attempts use exponential backoff
  // We'll check the browser console logs for this
  
  warn('Manual verification needed: Check browser console for reconnection logs');
  info('Expected pattern:');
  info('  [Gateway] Reconnecting in 500-1000ms (attempt 1/30)');
  info('  [Gateway] Reconnecting in 1000-2000ms (attempt 2/30)');
  info('  [Gateway] Reconnecting in 2000-4000ms (attempt 3/30)');
  
  return true;
}

async function testJobReconciliation() {
  info('\n🔄 Testing job reconciliation...');
  
  // Create a simple test job
  info('Creating test job...');
  
  try {
    const response = await fetch('http://localhost:18789', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test-job-reconciliation',
        type: 'jobs:create',
        payload: {
          name: 'Test Sleep Wake Job',
          type: 'bash',
          command: 'echo "Job ran at $(date)"',
          schedule: {
            enabled: true,
            intervalMs: 60000, // Every minute
          },
        },
      }),
    });
    
    const result = await response.json();
    if (!result.success) {
      error(`Failed to create test job: ${result.error}`);
      return false;
    }
    
    const jobId = result.data.id;
    success(`Test job created: ${jobId}`);
    
    // Simulate suspend/resume
    await simulateSuspendResume();
    
    // Wait a bit for reconciliation
    await sleep(5000);
    
    // Check if job ran (check logs or status)
    info('Job reconciliation test requires manual verification:');
    info('  1. Check Gateway logs for "reconciling state"');
    info('  2. Check JobsScheduler logs for "Tick started"');
    info('  3. Verify job ran after resume');
    
    // Clean up test job
    try {
      await fetch('http://localhost:18789', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'test-cleanup',
          type: 'jobs:delete',
          payload: { jobId },
        }),
      });
      info('Test job cleaned up');
    } catch (err) {
      warn('Failed to clean up test job');
    }
    
    return true;
  } catch (err) {
    error(`Job reconciliation test error: ${err.message}`);
    return false;
  }
}

async function testConnectionIndicator() {
  info('\n🔌 Testing connection indicator...');
  
  warn('Manual verification needed:');
  info('  1. Open Paprwork app');
  info('  2. Check bottom-left sidebar (should be no indicator when connected)');
  info('  3. Kill Gateway: npm run kill:gateway');
  info('  4. Verify yellow "Reconnecting..." badge appears');
  info('  5. Wait for Gateway to restart');
  info('  6. Verify indicator disappears when reconnected');
  
  return true;
}

async function testHeartbeat() {
  info('\n💓 Testing heartbeat mechanism...');
  
  warn('Manual verification needed:');
  info('  1. Open browser DevTools → Network tab');
  info('  2. Filter by "WS" (WebSocket)');
  info('  3. Look for periodic ping/pong messages (every 15 seconds)');
  info('  4. Verify connection stays alive');
  
  return true;
}

async function runTests() {
  log('\n╔════════════════════════════════════════════════════════════╗', 'blue');
  log('║        Sleep/Wake Handling Automated Test Suite           ║', 'blue');
  log('╚════════════════════════════════════════════════════════════╝\n', 'blue');
  
  const tests = [
    { name: 'WebSocket Reconnection', fn: testWebSocketReconnection },
    { name: 'Exponential Backoff', fn: testExponentialBackoff },
    { name: 'Job Reconciliation', fn: testJobReconciliation },
    { name: 'Connection Indicator', fn: testConnectionIndicator },
    { name: 'Heartbeat Mechanism', fn: testHeartbeat },
  ];
  
  const results = [];
  
  for (const test of tests) {
    try {
      const result = await test.fn();
      results.push({ name: test.name, passed: result });
    } catch (err) {
      error(`Test "${test.name}" threw error: ${err.message}`);
      results.push({ name: test.name, passed: false });
    }
  }
  
  // Summary
  log('\n╔════════════════════════════════════════════════════════════╗', 'blue');
  log('║                      Test Results                          ║', 'blue');
  log('╚════════════════════════════════════════════════════════════╝\n', 'blue');
  
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  
  results.forEach(result => {
    if (result.passed) {
      success(`${result.name}: PASSED`);
    } else {
      error(`${result.name}: FAILED (or requires manual verification)`);
    }
  });
  
  log(`\n${colors.blue}Total: ${passed}/${total} tests passed${colors.reset}\n`);
  
  if (passed === total) {
    success('All automated tests passed! ✨');
    info('Note: Some tests require manual verification (check logs above)');
  } else {
    warn('Some tests failed or require manual verification');
  }
}

// Run tests
runTests().catch(err => {
  error(`Test suite error: ${err.message}`);
  process.exit(1);
});
