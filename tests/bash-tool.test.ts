#!/usr/bin/env tsx
/**
 * Bash Tool Integration Test
 * 
 * Tests the bash tool execution in isolation
 */

import { bashTool, executeBashCommand } from '../src/core/tools/bash';
import type { BashInput } from '../src/core/tools/bash';

async function testBashTool() {
  console.log('🧪 Testing Bash Tool\n');

  // Test 1: Simple command
  console.log('Test 1: Simple echo command');
  const test1: BashInput = {
    command: 'echo "Hello from bash tool!"',
    cwd: '',
    timeout: 5000,
    env: {},
  };

  const result1 = await executeBashCommand(test1);
  console.log('✓ Result:', result1.success ? 'SUCCESS' : 'FAILED');
  if (result1.success && result1.data) {
    console.log('  stdout:', result1.data.stdout.trim());
    console.log('  duration:', result1.data.duration + 'ms\n');
  } else {
    console.log('  error:', result1.error, '\n');
  }

  // Test 2: Current directory
  console.log('Test 2: List current directory');
  const test2: BashInput = {
    command: 'pwd && ls -la | head -5',
    cwd: process.cwd(),
    timeout: 5000,
    env: {},
  };

  const result2 = await executeBashCommand(test2);
  console.log('✓ Result:', result2.success ? 'SUCCESS' : 'FAILED');
  if (result2.success && result2.data) {
    console.log('  stdout:', result2.data.stdout.trim());
    console.log('  duration:', result2.data.duration + 'ms\n');
  }

  // Test 3: Error handling (non-existent command)
  console.log('Test 3: Error handling');
  const test3: BashInput = {
    command: 'nonexistentcommand123',
    cwd: '',
    timeout: 5000,
    env: {},
  };

  const result3 = await executeBashCommand(test3);
  console.log('✓ Result:', result3.success ? 'SUCCESS' : 'FAILED (expected)');
  if (!result3.success) {
    console.log('  error:', result3.error);
    console.log('  type:', result3.type, '\n');
  }

  // Test 4: Timeout handling
  console.log('Test 4: Timeout handling');
  const test4: BashInput = {
    command: 'sleep 5',
    cwd: '',
    timeout: 1000, // 1 second timeout for 5 second sleep
    env: {},
  };

  const result4 = await executeBashCommand(test4);
  console.log('✓ Result:', result4.success ? 'SUCCESS' : 'FAILED (expected timeout)');
  if (!result4.success) {
    console.log('  error:', result4.error);
    console.log('  type:', result4.type, '\n');
  }

  // Test 5: Git command
  console.log('Test 5: Git status');
  const test5: BashInput = {
    command: 'git status --short',
    cwd: process.cwd(),
    timeout: 5000,
    env: {},
  };

  const result5 = await executeBashCommand(test5);
  console.log('✓ Result:', result5.success ? 'SUCCESS' : 'FAILED');
  if (result5.success && result5.data) {
    const output = result5.data.stdout.trim();
    console.log('  Git status:', output.length > 0 ? `\n${output}` : '(clean)');
    console.log('  duration:', result5.data.duration + 'ms\n');
  }

  console.log('✅ All bash tool tests completed!\n');
  console.log('💡 Next: Test bash tool in the UI by asking:');
  console.log('   "Run: ls -la" or "What files are in the current directory?"');
}

// Run tests
testBashTool().catch(console.error);
