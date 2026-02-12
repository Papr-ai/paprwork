#!/usr/bin/env tsx
/**
 * Test PAPR Memory SDK - Basic Connection Test
 * Tests if we can connect and access basic endpoints
 */

import Papr from '@papr/memory';
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.local
config({ path: join(__dirname, '..', '.env.local') });

const PAPR_API_KEY = process.env.PAPR_API_KEY || process.env.PAPR_MEMORY_API_KEY;

async function testConnection() {
  console.log('🔌 Testing PAPR Memory SDK Connection\n');
  
  if (!PAPR_API_KEY) {
    console.error('❌ PAPR_API_KEY not found in .env.local');
    process.exit(1);
  }

  const client = new Papr({
    xAPIKey: PAPR_API_KEY,
    baseURL: process.env.PAPR_BASE_URL || 'https://memory.papr.ai',
  });

  console.log('✓ SDK client created');
  console.log(`  Base URL: ${process.env.PAPR_BASE_URL || 'https://memory.papr.ai'}\n`);

  // Test 1: Try to create or get a user
  console.log('👤 Test 1: User API...');
  try {
    const user = await client.user.create({
      external_id: 'paprwork-v2-test',
    });
    console.log('✓ User created:', user);
  } catch (error: any) {
    if (error.status === 409) {
      console.log('✓ User already exists (409 Conflict)');
    } else {
      console.error('❌ User API failed:', error.status, error.message);
      if (error.error) {
        console.error('   Details:', JSON.stringify(error.error, null, 2));
      }
    }
  }

  // Test 2: Try to list users
  console.log('\n📋 Test 2: List users...');
  try {
    const users = await client.user.list({ limit: 5 });
    console.log('✓ Users list retrieved');
    console.log('  Total users:', users.users?.length || 0);
  } catch (error: any) {
    console.error('❌ List users failed:', error.status, error.message);
  }

  // Test 3: Try memory search (general endpoint, not session-specific)
  console.log('\n🔍 Test 3: Memory search...');
  try {
    const results = await client.memory.search({
      query: 'test',
      max_memories: 1,
    });
    console.log('✓ Memory search works');
    console.log('  Memories found:', results.data?.memories?.length || 0);
  } catch (error: any) {
    console.error('❌ Memory search failed:', error.status, error.message);
  }

  console.log('\n' + '='.repeat(60));
  console.log('Connection test complete!');
  console.log('If User and Memory APIs work but Messages API fails,');
  console.log('contact PAPR support about enabling the Messages API');
  console.log('for your account: https://platform.papr.ai');
}

testConnection().catch(console.error);
