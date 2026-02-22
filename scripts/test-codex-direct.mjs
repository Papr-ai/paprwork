#!/usr/bin/env node
/**
 * Test OpenAI Codex API directly
 * Usage: OPENAI_TOKEN=your_token node test-codex-direct.mjs
 */

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
  const token = process.env.OPENAI_TOKEN;
  if (!token) {
    console.error('❌ OPENAI_TOKEN environment variable not set');
    console.log('\nUsage: OPENAI_TOKEN=your_oauth_token node test-codex-direct.mjs');
    process.exit(1);
  }
  
  console.log('🧪 Testing OpenAI Codex API directly...\n');
  console.log('✅ Found OAuth token');
  
  const accountId = extractAccountId(token);
  console.log(`✅ Extracted account ID: ${accountId.substring(0, 20)}...\n`);
  
  // Test: Message with a single tool
  console.log('📝 Testing message with tool');
  const toolBody = {
    model: 'gpt-5.3-codex',
    store: false,
    stream: false,
    instructions: 'You are a helpful assistant.',
    input: [
      { role: 'user', content: 'Say hello' }
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
  
  const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
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
  
  const result = await response.text();
  console.log(`Status: ${response.status}`);
  
  if (!response.ok) {
    console.error('❌ Test failed!');
    console.error('Full error response:');
    console.error(result);
    process.exit(1);
  }
  
  console.log('✅ Test passed!');
  console.log('Response preview:');
  console.log(result.substring(0, 500));
}

testCodexAPI().catch(error => {
  console.error('❌ Test error:', error);
  process.exit(1);
});
