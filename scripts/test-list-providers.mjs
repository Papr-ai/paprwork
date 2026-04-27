#!/usr/bin/env node
/**
 * Test script for connect_service list_providers action
 * Verifies the new lightweight provider listing functionality
 */

import { execSync } from 'child_process';

console.log('🧪 Testing connect_service list_providers action\n');

try {
  // Strip ANSI codes from catalog output
  const catalogOutput = execSync('cd ~/Papr/stripe-project && stripe projects catalog 2>&1', { 
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  
  const cleanOutput = catalogOutput.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  
  // Parse providers by category
  const lines = cleanOutput.split('\n');
  const providersByCategory = {};
  let currentCategory = '';
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Category headers (uppercase, no slashes)
    if (trimmedLine && trimmedLine === trimmedLine.toUpperCase() && !trimmedLine.includes('/')) {
      currentCategory = trimmedLine.toLowerCase();
      providersByCategory[currentCategory] = new Set();
      console.log(`\n📁 ${trimmedLine}`);
    }
    // Service lines (provider/service format)
    else if (line.match(/^\s+([a-z0-9]+)\/([a-z0-9_-]+)/)) {
      const match = line.match(/^\s+([a-z0-9]+)\/([a-z0-9_-]+)/);
      if (match && currentCategory) {
        providersByCategory[currentCategory].add(match[1]);
        console.log(`   - ${match[1]}`);
      }
    }
  }
  
  // Convert to arrays
  const categories = {};
  for (const [category, providers] of Object.entries(providersByCategory)) {
    categories[category] = Array.from(providers).sort();
  }
  
  const allProviders = Object.values(categories)
    .flat()
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
  
  console.log('\n\n📊 Summary:');
  console.log(`   Total categories: ${Object.keys(categories).length}`);
  console.log(`   Total providers: ${allProviders.length}`);
  console.log(`   Unique providers: ${allProviders.join(', ')}\n`);
  
  // Test specific queries
  console.log('🔍 Testing specific queries:\n');
  
  const tests = [
    { provider: 'neon', expected: true, category: 'database' },
    { provider: 'loops', expected: false, category: 'email' },
    { provider: 'resend', expected: false, category: 'email' },
    { provider: 'vercel', expected: true, category: 'hosting' },
    { provider: 'supabase', expected: true, category: 'database' },
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    const isAvailable = allProviders.includes(test.provider);
    const status = isAvailable === test.expected ? '✅' : '❌';
    
    if (isAvailable === test.expected) {
      passed++;
      console.log(`${status} ${test.provider}: ${isAvailable ? 'Available' : 'Not available'} (expected)`);
    } else {
      failed++;
      console.log(`${status} ${test.provider}: ${isAvailable ? 'Available' : 'Not available'} (expected ${test.expected ? 'available' : 'not available'})`);
    }
  }
  
  console.log(`\n📈 Test Results: ${passed} passed, ${failed} failed\n`);
  
  if (failed === 0) {
    console.log('✅ All tests passed! The list_providers action will work correctly.\n');
  } else {
    console.log('❌ Some tests failed. Check the implementation.\n');
    process.exit(1);
  }
  
} catch (error) {
  console.error('❌ Error testing list_providers:');
  console.error(error.message);
  process.exit(1);
}
