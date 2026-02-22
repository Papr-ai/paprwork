#!/usr/bin/env node
/**
 * Test OpenAI Codex API directly with OAuth token
 * This bypasses all our code to isolate the issue
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get OAuth token from custom keys storage
function getOAuthToken() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const keysPath = join(homeDir, '.paprwork-v2', 'custom-keys.json');
  
  try {
    const keysData = fs.readFileSync(keysPath, 'utf-8');
    const keys = JSON.parse(keysData);
    
    // Check for OpenAI OAuth token
    if (keys.OPENAI_OAUTH?.token) {
      return keys.OPENAI_OAUTH.token;
    }
    
    console.error('No OPENAI_OAUTH token found in custom-keys.json');
    process.exit(1);
  } catch (error) {
    console.error('Failed to read custom keys:', error.message);
    process.exit(1);
  }
}

// Extract accountId from JWT token
function extractAccountId(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid token');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    const accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
    if (!accountId) throw new Error('No account ID in token');
    return accountId;
  } catch (error) {
    console.error('Failed to extract accountId:', error.message);
    process.exit(1);
  }
}

async function testCodexAPI() {
  console.log('🧪 Testing OpenAI Codex API directly...\n');
  
  const token = getOAuthToken();
  console.log('✅ Found OAuth token');
  
  const accountId = extractAccountId(token);
  console.log(`✅ Extracted account ID: ${accountId}\n`);
  
  // Test 1: Simple message without tools
  console.log('📝 Test 1: Simple message (no tools)');
  const simpleBody = {
    model: 'gpt-5.3-codex',
    store: false,
    stream: false,
    instructions: 'You are a helpful assistant.',
    input: [
      { role: 'user', content: 'Say hello' }
    ],
  };
  
  const simpleResponse = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'chatgpt-account-id': accountId,
      'OpenAI-Beta': 'responses=experimental',
      'originator': 'paprwork-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify(simpleBody),
  });
  
  const simpleResult = await simpleResponse.text();
  console.log(`Status: ${simpleResponse.status}`);
  console.log(`Response: ${simpleResult.substring(0, 200)}...\n`);
  
  if (!simpleResponse.ok) {
    console.error('❌ Simple test failed!');
    return;
  }
  
  console.log('✅ Simple test passed!\n');
  
  // Test 2: Message with a single tool
  console.log('📝 Test 2: Message with one tool');
  const toolBody = {
    model: 'gpt-5.3-codex',
    store: false,
    stream: false,
    instructions: 'You are a helpful assistant.',
    input: [
      { role: 'user', content: 'List files in my home directory' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a bash command',
          parameters: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'The bash command to run',
              },
            },
            required: ['command'],
          },
        },
      },
    ],
    tool_choice: 'auto',
    parallel_tool_calls: true,
  };
  
  console.log('Tool structure being sent:');
  console.log(JSON.stringify(toolBody.tools[0], null, 2));
  console.log('');
  
  const toolResponse = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'chatgpt-account-id': accountId,
      'OpenAI-Beta': 'responses=experimental',
      'originator': 'paprwork-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify(toolBody),
  });
  
  const toolResult = await toolResponse.text();
  console.log(`Status: ${toolResponse.status}`);
  console.log(`Response: ${toolResult.substring(0, 500)}...\n`);
  
  if (!toolResponse.ok) {
    console.error('❌ Tool test failed!');
    console.error('Full error response:');
    console.error(toolResult);
    return;
  }
  
  console.log('✅ Tool test passed!');
}

testCodexAPI().catch(console.error);
