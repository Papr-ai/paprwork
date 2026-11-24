#!/usr/bin/env tsx
/**
 * Test PAPR Memory SDK - Detailed Debugging
 * Tests authentication and endpoint access step by step
 */

import Papr, { type MessageStoreParams } from '@papr/memory';
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.local
config({ path: join(__dirname, '..', '.env.local') });

const PAPR_API_KEY = process.env.PAPR_API_KEY || process.env.PAPR_MEMORY_API_KEY;

async function debugPaprAuth() {
  console.log('🔍 PAPR Memory SDK - Detailed Authentication Debug\n');
  
  if (!PAPR_API_KEY) {
    console.error('❌ PAPR_API_KEY not found in .env.local');
    process.exit(1);
  }

  console.log('API Key format:', PAPR_API_KEY.substring(0, 20) + '...');
  console.log('API Key structure:');
  
  // Parse the key structure
  if (PAPR_API_KEY.startsWith('sk-org-')) {
    const parts = PAPR_API_KEY.split('-');
    console.log('  - Type: Organization-scoped key');
    console.log('  - Org ID:', parts[2] || 'unknown');
    console.log('  - Has namespace:', parts.includes('namespace'));
    if (parts.includes('namespace')) {
      const nsIndex = parts.indexOf('namespace');
      console.log('  - Namespace ID:', parts[nsIndex + 1] || 'unknown');
    }
  }
  console.log('');

  const client = new Papr({
    xAPIKey: PAPR_API_KEY,
    baseURL: process.env.PAPR_BASE_URL || 'https://memory.papr.ai',
    logLevel: 'debug',  // Enable debug logging
  });

  console.log('✓ SDK client created with debug logging enabled\n');
  console.log('='.repeat(70));

  // Test 1: Try the simplest possible message
  console.log('\n📝 Test 1: Store minimal message (no optional fields)...\n');
  try {
    const minimal: MessageStoreParams = {
      content: 'Test message from paprwork-v2',
      role: 'user',
      sessionId: `debug-test-${Date.now()}`,
    };

    console.log('Request:', JSON.stringify(minimal, null, 2));
    const response = await client.messages.store(minimal);
    
    console.log('\n✅ SUCCESS!');
    console.log('Response:', JSON.stringify(response, null, 2));
  } catch (error: any) {
    console.log('\n❌ FAILED');
    console.log('Status:', error.status);
    console.log('Message:', error.message);
    console.log('Error body:', JSON.stringify(error.error, null, 2));
    console.log('\n' + '='.repeat(70));
  }

  // Test 2: Try with process_messages=false (simpler, no memory creation)
  console.log('\n📝 Test 2: Store message WITHOUT processing...\n');
  try {
    const noProcess: MessageStoreParams = {
      content: 'Test message - no processing',
      role: 'user',
      sessionId: `debug-test-noprocess-${Date.now()}`,
      process_messages: false,  // Don't process into memories
    };

    console.log('Request:', JSON.stringify(noProcess, null, 2));
    const response = await client.messages.store(noProcess);
    
    console.log('\n✅ SUCCESS!');
    console.log('Response:', JSON.stringify(response, null, 2));
  } catch (error: any) {
    console.log('\n❌ FAILED');
    console.log('Status:', error.status);
    console.log('Message:', error.message);
    console.log('Error body:', JSON.stringify(error.error, null, 2));
  }

  console.log('\n' + '='.repeat(70));
  console.log('\n💡 Insights:');
  console.log('• If both tests fail with 500 "Failed to create chat session",');
  console.log('  this suggests an issue with the Chat class setup in Parse Server');
  console.log('• If auth was the issue, we would get 401 errors');
  console.log('• The org/namespace scoped key might require special Parse Server configuration');
}

debugPaprAuth().catch(console.error);
