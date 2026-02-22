/**
 * Direct Test: Verify agent tracking in database
 * This directly checks the databases to verify tracking works
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

console.log('\n🧪 Agent Tracking Database Verification Test');
console.log('='.repeat(60));

let passed = 0;
let failed = 0;

function test(name, condition, details) {
  if (condition) {
    console.log(`✅ PASS: ${name}`);
    if (details) console.log(`   ${details}`);
    passed++;
  } else {
    console.log(`❌ FAIL: ${name}`);
    if (details) console.log(`   ${details}`);
    failed++;
  }
}

// Check possible database locations
const possiblePaths = [
  path.join(os.homedir(), '.paprwork-v2', 'chats.db'),
  path.join(os.homedir(), 'PAPR', 'data', 'chats.db'),
  path.join(os.homedir(), 'Library', 'Application Support', 'paprwork-v2', 'data', 'chats.db'),
];

let chatsDbPath = possiblePaths.find(p => fs.existsSync(p));
const plansDbPath = path.join(os.homedir(), 'PAPR', 'data', 'plans.db');

console.log('\n📁 Database Paths:');
console.log(`   Searching for chats database...`);
possiblePaths.forEach((p, idx) => {
  const exists = fs.existsSync(p);
  console.log(`   ${idx + 1}. ${p} ${exists ? '✓' : '✗'}`);
});
console.log(`   Plans: ${plansDbPath}`);

// Test 1: Chats database exists
if (!chatsDbPath) {
  console.log('\n❌ No chats database found in any expected location!');
  console.log('\n⚠️  Possible reasons:');
  console.log('   1. App is using PAPR Memory storage (cloud mode)');
  console.log('   2. No messages have been sent yet');
  console.log('   3. Database is in a different location');
  console.log('\nTo test tracking:');
  console.log('   1. Make sure the app is in Local storage mode');
  console.log('   2. Send at least one message to the agent');
  console.log('   3. Run this script again');
  process.exit(0);
}

test(
  'Chats database exists',
  fs.existsSync(chatsDbPath),
  `Path: ${chatsDbPath}`
);

if (!fs.existsSync(chatsDbPath)) {
  console.log('\n⚠️  No chats database found. Create a chat in the app first.');
  process.exit(0);
}

// Test 2: Messages table has required columns
console.log('\n📊 Test: Messages Table Schema');
const chatsDb = new Database(chatsDbPath);

const columns = chatsDb.pragma('table_info(messages)');
const columnNames = columns.map(c => c.name);

console.log(`   Found ${columns.length} columns`);

test(
  'Messages table has total_tokens column',
  columnNames.includes('total_tokens'),
  'Required for token tracking'
);

test(
  'Messages table has cost column',
  columnNames.includes('cost'),
  'Required for cost tracking'
);

test(
  'Messages table has source_agent_id column',
  columnNames.includes('source_agent_id'),
  'Required for agent attribution'
);

test(
  'Messages table has source_agent_name column',
  columnNames.includes('source_agent_name'),
  'Required for agent attribution'
);

// Test 3: Check if we have any messages with token data
console.log('\n📊 Test: Token Data in Messages');
const messagesWithTokens = chatsDb
  .prepare('SELECT COUNT(*) as count FROM messages WHERE total_tokens IS NOT NULL AND total_tokens > 0')
  .get();

console.log(`   Messages with token data: ${messagesWithTokens.count}`);
test(
  'At least one message has token data',
  messagesWithTokens.count > 0,
  messagesWithTokens.count === 0 
    ? 'Send a message to the agent first'
    : `Found ${messagesWithTokens.count} message(s) with tokens`
);

// Test 4: Check if we have any messages with cost data
console.log('\n📊 Test: Cost Data in Messages');
const messagesWithCost = chatsDb
  .prepare('SELECT COUNT(*) as count FROM messages WHERE cost IS NOT NULL AND cost > 0')
  .get();

console.log(`   Messages with cost data: ${messagesWithCost.count}`);
test(
  'At least one message has cost data',
  messagesWithCost.count > 0,
  messagesWithCost.count === 0
    ? 'Send a message to the agent first'
    : `Found ${messagesWithCost.count} message(s) with cost`
);

// Test 5: Show sample data if available
if (messagesWithTokens.count > 0) {
  console.log('\n📊 Sample Message Data:');
  const sampleMessage = chatsDb
    .prepare('SELECT role, model, total_tokens, prompt_tokens, completion_tokens, cost, source_agent_id, source_agent_name FROM messages WHERE total_tokens > 0 LIMIT 1')
    .get();
  
  console.log(`   Role: ${sampleMessage.role}`);
  console.log(`   Model: ${sampleMessage.model || 'N/A'}`);
  console.log(`   Total Tokens: ${sampleMessage.total_tokens}`);
  console.log(`   Prompt Tokens: ${sampleMessage.prompt_tokens || 'N/A'}`);
  console.log(`   Completion Tokens: ${sampleMessage.completion_tokens || 'N/A'}`);
  console.log(`   Cost: $${sampleMessage.cost || '0'}`);
  console.log(`   Agent ID: ${sampleMessage.source_agent_id || 'N/A (main agent)'}`);
  console.log(`   Agent Name: ${sampleMessage.source_agent_name || 'N/A'}`);
}

chatsDb.close();

// Test 6: Plans database schema
if (fs.existsSync(plansDbPath)) {
  console.log('\n📊 Test: Plans Table Schema');
  const plansDb = new Database(plansDbPath);
  
  const planColumns = plansDb.pragma('table_info(plans)');
  const planColumnNames = planColumns.map(c => c.name);
  
  test(
    'Plans table has source_agent_id column',
    planColumnNames.includes('source_agent_id'),
    'Required for plan attribution'
  );
  
  test(
    'Plans table has source_agent_name column',
    planColumnNames.includes('source_agent_name'),
    'Required for plan attribution'
  );
  
  plansDb.close();
} else {
  console.log('\n⚠️  Plans database not found (this is okay if no plans created yet)');
}

// Test 7: Document attribution
console.log('\n📊 Test: Document Attribution');
const docsPath = path.join(os.homedir(), 'PAPR', 'documents');

if (fs.existsSync(docsPath)) {
  const docDirs = fs.readdirSync(docsPath).filter(f => {
    const stats = fs.statSync(path.join(docsPath, f));
    return stats.isDirectory();
  });
  
  console.log(`   Found ${docDirs.length} document(s)`);
  
  if (docDirs.length > 0) {
    const sampleDocMeta = path.join(docsPath, docDirs[0], 'meta.json');
    if (fs.existsSync(sampleDocMeta)) {
      const meta = JSON.parse(fs.readFileSync(sampleDocMeta, 'utf8'));
      test(
        'Document meta.json has createdByAgentId field',
        'createdByAgentId' in meta,
        meta.createdByAgentId 
          ? `Sample doc created by: ${meta.createdByAgentId}`
          : 'Field exists but not set (document created before attribution)'
      );
    }
  }
} else {
  console.log('   No documents found (create a document to test)');
}

// Test 8: App attribution
console.log('\n📊 Test: App Attribution');
const appsJsonPath = path.join(os.homedir(), 'PAPR', 'data', 'apps.json');

if (fs.existsSync(appsJsonPath)) {
  const apps = JSON.parse(fs.readFileSync(appsJsonPath, 'utf8'));
  console.log(`   Found ${apps.length} app(s)`);
  
  if (apps.length > 0) {
    test(
      'App has createdByAgentId field',
      'createdByAgentId' in apps[0],
      apps[0].createdByAgentId
        ? `Sample app created by: ${apps[0].createdByAgentId}`
        : 'Field exists but not set (app created before attribution)'
    );
  }
} else {
  console.log('   No apps found (create an app to test)');
}

// Summary
console.log('\n' + '='.repeat(60));
console.log('TEST SUMMARY');
console.log('='.repeat(60));
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);

if (failed === 0) {
  console.log('\n🎉 All tests passed! Agent tracking is working correctly.');
  process.exit(0);
} else {
  console.log('\n⚠️  Some tests failed. Check the output above for details.');
  process.exit(1);
}
