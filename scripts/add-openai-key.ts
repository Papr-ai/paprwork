#!/usr/bin/env node
/**
 * Add OpenAI API key from .env.local to Electron secure storage
 * Run this once to enable AI-powered title generation
 */

import dotenv from 'dotenv';
import { CustomKeysStorage } from '../src/core/storage/CustomKeysStorage.js';
import { app } from 'electron';

// Load .env.local
dotenv.config({ path: '.env.local' });

async function main() {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  
  if (!OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY not found in .env.local');
    process.exit(1);
  }

  //console.log('✓ Found OPENAI_API_KEY in .env.local');
  //console.log(`  Key: ${OPENAI_API_KEY.substring(0, 10)}...`);

  // Wait for Electron app to be ready
  await app.whenReady();
  
  // Set app name for keychain (must match main.js)
  app.setName('Papr Work');

  // Initialize storage
  const storage = new CustomKeysStorage();
  await storage.initialize();

  // Add the key
  const result = await storage.addKey({
    name: 'OPENAI_API_KEY',
    value: OPENAI_API_KEY,
    description: 'OpenAI API key for chat and title generation',
    permission: 'always',
  });

  console.log('✓ Added OPENAI_API_KEY to secure storage');
  //console.log(`  ID: ${result.id}`);
  
  // Verify it can be retrieved
  const retrieved = await storage.getKeyByName('OPENAI_API_KEY');
  if (retrieved === OPENAI_API_KEY) {
    //console.log('✓ Verified: Key can be retrieved from secure storage');
  } else {
    console.error('❌ Verification failed: Retrieved key does not match');
  }

  app.quit();
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
