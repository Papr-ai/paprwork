#!/usr/bin/env node
/**
 * Index Code to PAPR Memory Cloud
 *
 * Usage:
 *   npm run index:code
 *   # OR with explicit key:
 *   PAPR_API_KEY=your-key npm run index:code
 * 
 * This script tries to get the PAPR API key from:
 * 1. Environment variable (PAPR_API_KEY)
 * 2. Gateway's keychain (requires running Gateway process)
 */

import { Papr } from '@papr/memory';
import { registerCodeSchema, seedControlledVocabulary } from '../services/CodeSchemaRegistration.js';
import { CodeIndexerService } from '../services/storage/CodeIndexerService.js';
import { CodeIndexTracker } from '../services/storage/CodeIndexTracker.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SCHEMA_FILE = path.join(os.homedir(), '.paprwork-v2', 'code-schema-id.txt');

async function getApiKey(): Promise<string | null> {
  // Try environment variable first
  if (process.env.PAPR_API_KEY) {
    console.log('✓ Using API key from environment variable\n');
    return process.env.PAPR_API_KEY;
  }
  
  // Try keychain via Gateway's keyResolver
  try {
    const { getApiKey: getApiKeyFromKeychain } = await import('../utils/keyResolver.js');
    const key = await getApiKeyFromKeychain('PAPR_API_KEY');
    if (key) {
      console.log('✓ API key loaded from keychain\n');
      return key;
    }
  } catch (error) {
    // Keychain not available
  }
  
  return null;
}

async function main() {
  console.log('🚀 PAPR Code Indexer\n');

  try {
    // Get API key
    console.log('📋 Fetching PAPR API key...');
    const apiKey = await getApiKey();
    
    if (!apiKey) {
      console.error('❌ No PAPR_API_KEY found');
      console.log('\n💡 Options:');
      console.log('   1. Add key in Settings > API Keys (when app is running)');
      console.log('   2. Or set environment variable: export PAPR_API_KEY=your-key');
      console.log('   3. Or pass inline: PAPR_API_KEY=your-key npm run index:code');
      process.exit(1);
    }

    // Initialize PAPR client
    console.log('🔌 Connecting to PAPR Memory Cloud...');
    const client = new Papr({ xAPIKey: apiKey });

    // Step 1: Get or register schema
    let schema_id: string;
    
    if (fs.existsSync(SCHEMA_FILE)) {
      schema_id = fs.readFileSync(SCHEMA_FILE, 'utf-8').trim();
      console.log(`\n📋 Using cached schema: ${schema_id}`);
    } else {
      console.log('\n📋 Step 1: Register Code Schema');
      const result = await registerCodeSchema(client);
      schema_id = result.schema_id;
      
      // Cache it
      const dir = path.dirname(SCHEMA_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SCHEMA_FILE, schema_id, 'utf-8');
      
      // Seed controlled vocabulary
      console.log('\n🌱 Step 2: Seed Controlled Vocabulary');
      await seedControlledVocabulary(client);
    }

    // Step 2: Initialize tracker
    console.log('\n📦 Step 3: Index Code Files');
    const tracker = new CodeIndexTracker();
    const beforeStats = tracker.getStats();
    
    console.log(`   Before: ${beforeStats.total_files} files indexed, ${beforeStats.queue_size} queued`);

    // Step 3: Index all code
    const indexer = new CodeIndexerService(client, schema_id);
    const stats = await indexer.indexAllCode();

    // Step 4: Record indexed files in tracker
    console.log('\n📊 Updating index tracker...');
    
    const afterStats = tracker.getStats();
    console.log(`   After: ${afterStats.total_files} files indexed, ${afterStats.queue_size} queued`);

    tracker.close();

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('🎉 Code Indexing Complete!');
    console.log('='.repeat(50));
    console.log(`Schema ID: ${schema_id}`);
    console.log(`Projects indexed: ${stats.projects}`);
    console.log(`Files indexed: ${stats.files}`);

    if (stats.errors.length > 0) {
      console.log(`\n⚠️  Errors encountered: ${stats.errors.length}`);
      stats.errors.slice(0, 10).forEach(err => console.log(`   - ${err}`));
      if (stats.errors.length > 10) {
        console.log(`   ... and ${stats.errors.length - 10} more`);
      }
    }

    console.log('\n✅ You can now search your code using the agent tools!');
    console.log('   Try: "Find code that fetches GitHub data"');

  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    if (error instanceof Error) {
      console.error('   Message:', error.message);
    }
    process.exit(1);
  }
}

main().catch(console.error);
