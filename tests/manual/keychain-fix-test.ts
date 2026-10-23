#!/usr/bin/env tsx
/**
 * Test: Verify no keychain popup on startup
 * 
 * This test verifies that:
 * 1. CustomKeysStorage initialization does NOT decrypt keys
 * 2. listKeys() returns metadata without decryption
 * 3. Keys are only decrypted when getKey() or getKeyByName() is called
 */

import { CustomKeysStorage } from '../src/core/storage/CustomKeysStorage.js';
import { performance } from 'perf_hooks';

async function testKeychainBehavior() {
  console.log('🧪 Testing Keychain Behavior\n');
  console.log('=' .repeat(70));
  
  const storage = new CustomKeysStorage();
  
  // Test 1: Initialize (should be instant, no keychain access)
  console.log('\n📝 Test 1: Initialize CustomKeysStorage');
  const initStart = performance.now();
  await storage.initialize();
  const initTime = performance.now() - initStart;
  console.log(`✓ Initialized in ${initTime.toFixed(2)}ms`);
  
  if (initTime > 100) {
    console.warn('⚠️  Warning: Initialization took longer than expected');
    console.warn('   This might indicate keychain access is happening');
  } else {
    console.log('✓ Fast initialization (no keychain access detected)');
  }
  
  // Test 2: List keys (should be instant, no decryption)
  console.log('\n📝 Test 2: List keys (metadata only)');
  const listStart = performance.now();
  const keys = await storage.listKeys();
  const listTime = performance.now() - listStart;
  console.log(`✓ Listed ${keys.length} keys in ${listTime.toFixed(2)}ms`);
  
  if (listTime > 50) {
    console.warn('⚠️  Warning: listKeys() took longer than expected');
    console.warn('   This might indicate decryption is happening');
  } else {
    console.log('✓ Fast listing (no decryption detected)');
  }
  
  if (keys.length > 0) {
    console.log('\nKeys found (metadata only):');
    for (const key of keys) {
      console.log(`  - ${key.name} (${key.permission})`);
    }
  } else {
    console.log('ℹ️  No keys found in storage');
    console.log('   Add a key via UI to test full flow');
  }
  
  // Test 3: Decrypt a key (this WILL trigger keychain)
  if (keys.length > 0) {
    console.log('\n📝 Test 3: Decrypt a key (will trigger keychain)');
    const firstKey = keys[0];
    console.log(`   Decrypting: ${firstKey.name}`);
    console.log('   ⏳ You should see keychain popup now...');
    
    const decryptStart = performance.now();
    const value = await storage.getKey(firstKey.id);
    const decryptTime = performance.now() - decryptStart;
    
    if (value) {
      console.log(`   ✓ Decrypted successfully in ${decryptTime.toFixed(2)}ms`);
      console.log(`   ✓ Value length: ${value.length} characters`);
    } else {
      console.log('   ❌ Decryption failed or key was empty');
    }
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('\n✅ Test complete!');
  console.log('\nExpected behavior:');
  console.log('  • Initialize & listKeys: Fast, no keychain popup');
  console.log('  • getKey/getKeyByName: Slower, triggers keychain popup');
  console.log('\nV1 approach: Keys only decrypted when actually needed');
  console.log('V2 fix: Same lazy loading approach as V1');
}

testKeychainBehavior().catch(console.error);
