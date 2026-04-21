#!/usr/bin/env node
/**
 * Test script to reproduce the PAPR message sync failure
 * WITHOUT using better-sqlite3 (to avoid native module issues)
 */

import Papr from '@papr/memory';
import { readFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

// Data extracted from SQLite query results
const FAILED_MESSAGE_DATA = {
  id: 'msg-1014d438-6983-4d6d-8235-b80966b192db',
  chat_id: '95992479-4fe0-4acb-883d-5cbea7de5eb7',
  role: 'assistant',
  content: readFileSync('/tmp/test-message-content.txt', 'utf-8').trim(),
  thinking: `Let me start by finding the project and understanding the context. I need to:
1. Find the memory project in the GitHub folder
2. Check the chat folder in /Papr for context
3. Understand the search with holo enabled and frequency scores issue`,
  // Tool calls will be loaded from a separate dump
};

async function testMessageSync() {
  console.log('🧪 Testing PAPR message sync with the exact failed message...\n');

  console.log('📦 Message details:');
  console.log(`   ID: ${FAILED_MESSAGE_DATA.id}`);
  console.log(`   Chat ID: ${FAILED_MESSAGE_DATA.chat_id}`);
  console.log(`   Role: ${FAILED_MESSAGE_DATA.role}`);
  console.log(`   Content length: ${FAILED_MESSAGE_DATA.content.length} chars`);
  console.log(`   Thinking length: ${FAILED_MESSAGE_DATA.thinking.length} chars`);
  console.log();

  // Extract tool calls from SQLite
  console.log('🔧 Extracting tool calls from SQLite...');
  const { execSync } = await import('child_process');
  const toolCallsJson = execSync(
    `cd ~/.paprwork-v2 && sqlite3 chats.db "SELECT tool_calls FROM messages WHERE id = '${FAILED_MESSAGE_DATA.id}'"`,
    { encoding: 'utf-8' }
  ).trim();

  const toolCalls = JSON.parse(toolCallsJson);
  console.log(`   Tool calls count: ${toolCalls.length}`);
  console.log(`   Original tool_calls size: ${toolCallsJson.length} chars (${(toolCallsJson.length / 1024).toFixed(1)} KB)`);
  console.log();

  // Build the payload exactly as version 2.0.23 did
  const richContent = JSON.stringify({
    text: FAILED_MESSAGE_DATA.content,
    thinking: FAILED_MESSAGE_DATA.thinking,
    toolCalls: toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.args,
      result: tc.result ? String(tc.result).substring(0, 500) : undefined,
      status: tc.status,
    })),
    model: 'claude-sonnet-4-6',
  });

  console.log('📤 Prepared payload (JSON string format with 500-char truncation):');
  console.log(`   Total payload size: ${richContent.length} chars (${(richContent.length / 1024).toFixed(1)} KB)`);
  console.log();

  // Try to send to PAPR
  const apiKey = process.env.PAPR_API_KEY;
  if (!apiKey) {
    console.error('❌ PAPR_API_KEY not found in .env.local');
    process.exit(1);
  }

  const client = new Papr({
    xAPIKey: apiKey,
    maxRetries: 1, // Only try once for this test
    timeout: 30000,
  });

  console.log('🚀 Sending to PAPR /v1/messages endpoint...');
  const testSessionId = `test-sync-${Date.now()}`;
  console.log(`   Test session ID: ${testSessionId}`);
  console.log();

  try {
    const startTime = Date.now();
    const response = await client.messages.store({
      content: richContent,
      role: FAILED_MESSAGE_DATA.role,
      sessionId: testSessionId,
      process_messages: false, // Don't trigger background processing
      metadata: {
        conversationId: testSessionId,
        createdAt: new Date().toISOString(),
        role: FAILED_MESSAGE_DATA.role,
        customMetadata: {
          test: true,
          originalMessageId: FAILED_MESSAGE_DATA.id,
          reason: 'Testing sync failure reproduction - April 19, 2026 failed message',
          toolCallsCount: toolCalls.length,
          payloadSizeKB: (richContent.length / 1024).toFixed(1),
        },
      },
    });

    const elapsed = Date.now() - startTime;

    console.log('✅ SUCCESS! Message saved to PAPR');
    console.log(`   PAPR objectId: ${response.objectId}`);
    console.log(`   Session ID: ${response.sessionId}`);
    console.log(`   Elapsed time: ${elapsed}ms`);
    console.log();
    console.log('🎯 CONCLUSION:');
    console.log('   - The message format with 78 tool calls is VALID ✅');
    console.log('   - PAPR can handle this payload size');
    console.log('   - The April 19 failure was likely a TRANSIENT server error');
    console.log('   - Recommendation: Implement background retry for failed syncs');
    console.log();
    
  } catch (error) {
    console.error('❌ FAILED! Message could not be saved to PAPR');
    console.error();
    console.error('Error details:');
    
    if (error.status) {
      console.error(`   HTTP Status: ${error.status}`);
    }
    if (error.message) {
      console.error(`   Error Message: ${error.message}`);
    }
    if (error.body) {
      console.error(`   Response Body: ${JSON.stringify(error.body, null, 2)}`);
    }
    console.error();
    console.error('Full error object:', error);
    console.error();
    console.error('🎯 CONCLUSION:');
    console.error('   - The message format may be INVALID ❌');
    console.error('   - OR PAPR has a persistent issue with this specific content');
    console.error('   - Need to investigate backend logs or try with smaller payload');
    console.error();
    
    process.exit(1);
  }
}

testMessageSync().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
