#!/usr/bin/env node
/**
 * Test Automatic Hybrid Code Search
 * 
 * Tests that bash grep commands in PAPR folders automatically
 * trigger parallel Papr Memory semantic search.
 */

import { executeBashCommand } from '../src/core/tools/bash.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function testHybridSearch() {
  console.log('🧪 Testing Automatic Hybrid Code Search\n');
  
  // Test 1: grep in ~/Papr/apps/
  console.log('Test 1: grep in ~/Papr/apps/');
  console.log('Command: grep -r "authentication" ~/Papr/apps/');
  
  try {
    const result = await executeBashCommand({
      command: 'grep -r "chart" ~/Papr/apps/ | head -5',
      timeout: 10000
    });
    
    if (result.success && result.data) {
      const output = result.data.stdout;
      
      // Check if output contains both sections
      const hasMemorySection = output.includes('=== Memory Search Results');
      const hasGrepSection = output.includes('=== Grep Results');
      
      console.log('\n📊 Results:');
      console.log(`   Memory section: ${hasMemorySection ? '✅' : '❌'}`);
      console.log(`   Grep section: ${hasGrepSection ? '✅' : '❌'}`);
      console.log(`   Output length: ${output.length} chars`);
      
      if (hasMemorySection && hasGrepSection) {
        console.log('\n✅ Test 1 PASSED - Hybrid search working!\n');
        console.log('Sample output:');
        console.log(output.substring(0, 500) + '...\n');
      } else if (hasGrepSection && !hasMemorySection) {
        console.log('\n⚠️  Test 1 PARTIAL - Only grep results (memory may be empty or not indexed yet)\n');
      } else {
        console.log('\n❌ Test 1 FAILED - Missing expected sections\n');
      }
    } else {
      console.log('❌ Test 1 FAILED - Command failed');
      console.log('Error:', result.error);
    }
  } catch (error) {
    console.error('❌ Test 1 ERROR:', error);
  }
  
  // Test 2: grep NOT in PAPR folder (should not trigger memory search)
  console.log('\nTest 2: grep NOT in PAPR folder (should skip memory search)');
  console.log('Command: grep -r "function" ./src/ | head -5');
  
  try {
    const result = await executeBashCommand({
      command: 'grep -r "function" ./src/ | head -5',
      timeout: 10000
    });
    
    if (result.success && result.data) {
      const output = result.data.stdout;
      const hasMemorySection = output.includes('=== Memory Search Results');
      
      console.log('\n📊 Results:');
      console.log(`   Memory section: ${hasMemorySection ? '❌ Should not appear' : '✅ Correctly skipped'}`);
      console.log(`   Output length: ${output.length} chars`);
      
      if (!hasMemorySection) {
        console.log('\n✅ Test 2 PASSED - Memory search correctly skipped for non-PAPR paths\n');
      } else {
        console.log('\n❌ Test 2 FAILED - Memory search triggered when it should not\n');
      }
    }
  } catch (error) {
    console.error('❌ Test 2 ERROR:', error);
  }
  
  // Test 3: Check indexing status
  console.log('\nTest 3: Indexing Status');
  
  const dbPath = path.join(os.homedir(), '.paprwork-v2', 'code-index.db');
  if (fs.existsSync(dbPath)) {
    console.log('✅ Index database exists:', dbPath);
    
    // Would need better-sqlite3 to query, just check existence for now
    const stats = fs.statSync(dbPath);
    console.log(`   Size: ${(stats.size / 1024).toFixed(1)} KB`);
    console.log(`   Modified: ${stats.mtime.toISOString()}`);
  } else {
    console.log('❌ Index database not found');
  }
  
  console.log('\n🎉 Tests complete!\n');
  console.log('💡 Tips:');
  console.log('   - If memory section is empty, files may not be indexed yet (wait 10-20s)');
  console.log('   - Check logs for: [Bash Tool] Detected grep in PAPR folder');
  console.log('   - Check indexing: sqlite3 ~/.paprwork-v2/code-index.db "SELECT COUNT(*) FROM indexed_files"');
}

testHybridSearch().catch(console.error);
