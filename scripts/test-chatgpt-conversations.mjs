#!/usr/bin/env node
/**
 * Test ChatGPT backend-api conversations endpoint
 * Attempts to list user's prior ChatGPT conversations
 * 
 * Based on reverse engineering research:
 * - Endpoint pattern: https://chatgpt.com/backend-api/conversations
 * - Requires: Authorization, chatgpt-account-id, potentially csrf-token
 * - May require pre-flight to /sentinel/chat-requirements
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
    
    if (keys.OPENAI_OAUTH?.token) {
      return keys.OPENAI_OAUTH.token;
    }
    
    console.error('❌ No OPENAI_OAUTH token found in custom-keys.json');
    console.error('   Connect your ChatGPT account in Paprwork first.');
    process.exit(1);
  } catch (error) {
    console.error('❌ Failed to read custom keys:', error.message);
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
    console.error('❌ Failed to extract accountId:', error.message);
    process.exit(1);
  }
}

async function testConversationsEndpoint() {
  console.log('🔍 Testing ChatGPT Conversations List Endpoint\n');
  console.log('=' .repeat(60));
  
  const token = getOAuthToken();
  console.log('✅ Found OAuth token');
  
  const accountId = extractAccountId(token);
  console.log(`✅ Extracted account ID: ${accountId}`);
  console.log('=' .repeat(60) + '\n');
  
  // Test endpoint (CONFIRMED via browser DevTools - 2026-02-23)
  const endpoints = [
    {
      name: 'Conversations List (CONFIRMED)',
      url: 'https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=-updated&is_archived=false&is_starred=false',
      method: 'GET',
      confirmed: true,
    },
    {
      name: 'Conversations (minimal params)',
      url: 'https://chatgpt.com/backend-api/conversations?limit=20&offset=0',
      method: 'GET',
    },
    {
      name: 'Conversations (no params)',
      url: 'https://chatgpt.com/backend-api/conversations',
      method: 'GET',
    },
  ];
  
  for (const endpoint of endpoints) {
    const badge = endpoint.confirmed ? '✅ CONFIRMED' : '🔍 TESTING';
    console.log(`\n📝 ${badge}: ${endpoint.name}`);
    console.log(`   URL: ${endpoint.url}`);
    console.log(`   Method: ${endpoint.method}`);
    console.log('-'.repeat(60));
    
    try {
      const response = await fetch(endpoint.url, {
        method: endpoint.method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': '*/*',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
      });
      
      console.log(`   Status: ${response.status} ${response.statusText}`);
      console.log(`   Content-Type: ${response.headers.get('content-type')}`);
      
      const text = await response.text();
      
      if (response.ok) {
        console.log(`   ✅ SUCCESS!`);
        
        // Try to parse as JSON
        try {
          const json = JSON.parse(text);
          console.log(`   Response structure:`);
          console.log(JSON.stringify(json, null, 2).substring(0, 1000));
          
          // If this is a conversations list, show summary
          if (json.items || Array.isArray(json)) {
            const items = json.items || json;
            console.log(`\n   📊 Found ${items.length} conversations!`);
            if (items.length > 0) {
              console.log(`\n   Sample conversations (first 3):`);
              items.slice(0, 3).forEach((conv, idx) => {
                console.log(`\n   ${idx + 1}. ${conv.title || 'Untitled'}`);
                console.log(`      ID: ${conv.id || 'N/A'}`);
                console.log(`      Created: ${conv.create_time || 'N/A'}`);
                console.log(`      Updated: ${conv.update_time || 'N/A'}`);
                console.log(`      Model: ${conv.model_slug || 'N/A'}`);
              });
            }
            
            // Show pagination info
            if (json.total !== undefined) {
              console.log(`\n   Pagination:`);
              console.log(`      Total: ${json.total}`);
              console.log(`      Limit: ${json.limit || 'N/A'}`);
              console.log(`      Offset: ${json.offset || 0}`);
              console.log(`      Has More: ${json.has_next || json.has_more || 'N/A'}`);
            }
          }
        } catch (e) {
          console.log(`   Response (raw, first 500 chars):`);
          console.log(`   ${text.substring(0, 500)}`);
        }
      } else {
        console.log(`   ❌ FAILED`);
        console.log(`   Error: ${text.substring(0, 300)}`);
      }
      
    } catch (error) {
      console.log(`   ❌ ERROR: ${error.message}`);
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('🏁 Testing complete!');
  console.log('\nNext steps:');
  console.log('1. If any endpoint returned 200, note the URL and response structure');
  console.log('2. Check if additional headers are needed (csrf-token, etc.)');
  console.log('3. May need to call /sentinel/chat-requirements first');
  console.log('4. Consider using browser DevTools on chatgpt.com to capture real requests');
}

testConversationsEndpoint().catch(console.error);
