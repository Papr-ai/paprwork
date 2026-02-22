#!/usr/bin/env node
/**
 * Simple test using the built dist code (same as production)
 * This uses Electron's Node version which has the correct native modules
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('\n🧪 Running Agent Tracking Test via Electron Node\n');

// Create a test script that will run in Electron's context
const testScript = `
const { LocalStorageProvider } = require('./dist/gateway/services/storage/LocalStorageProvider.js');
const { StorageManager } = require('./dist/gateway/services/StorageManager.js');
const { initializeDocumentService } = require('./dist/gateway/services/DocumentService.js');
const { initializeAppService } = require('./dist/gateway/services/AppService.js');
const { initializePlanService } = require('./dist/gateway/services/PlanService.js');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const TEST_DATA_PATH = path.join(os.tmpdir(), 'agent-test-' + Date.now());
const TEST_CHAT_ID = 'test-' + Date.now();
const TEST_AGENT_ID = 'test-agent';
const TEST_AGENT_NAME = 'Test Agent';

async function runTest() {
  console.log('📦 Setting up test environment...');
  console.log('   Test path:', TEST_DATA_PATH);
  
  await fs.remove(TEST_DATA_PATH);
  await fs.ensureDir(TEST_DATA_PATH);

  // Initialize storage
  const storageManager = new StorageManager();
  await storageManager.initialize({ mode: 'local', userDataPath: TEST_DATA_PATH });
  console.log('✓ Storage initialized');

  // Create a test chat
  await storageManager.createChat(TEST_CHAT_ID, 'Test Chat');
  console.log('✓ Chat created');

  // Manually insert a message with token and cost data
  const db = new Database(path.join(TEST_DATA_PATH, 'chats.db'));
  
  db.prepare(\`
    INSERT INTO messages (id, chat_id, role, content, timestamp, sync_status, model, total_tokens, prompt_tokens, completion_tokens, cost, source_agent_id, source_agent_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  \`).run(
    'msg-test-1',
    TEST_CHAT_ID,
    'assistant',
    'Hello, this is a test response',
    new Date().toISOString(),
    'local',
    'gpt-4o-mini',
    150,    // total_tokens
    100,    // prompt_tokens
    50,     // completion_tokens
    0.0015, // cost
    TEST_AGENT_ID,
    TEST_AGENT_NAME
  );
  console.log('✓ Test message inserted');

  // Test 1: Verify message in database
  const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ?').all(TEST_CHAT_ID);
  console.log('\\n📊 Test 1: Message in Database');
  console.log('   Messages found:', messages.length);
  console.log('   Total tokens:', messages[0].total_tokens);
  console.log('   Cost:', messages[0].cost);
  console.log('   Agent ID:', messages[0].source_agent_id);
  
  if (messages[0].total_tokens === 150 && messages[0].cost === 0.0015) {
    console.log('   ✅ PASS: Tokens and cost tracked correctly');
  } else {
    console.log('   ❌ FAIL: Token or cost mismatch');
  }

  // Test 2: Query via storage manager
  console.log('\\n📊 Test 2: Global Cost Stats API');
  const globalStats = await storageManager.getGlobalCostStats();
  console.log('   Total cost:', globalStats.total);
  console.log('   Total messages:', globalStats.totalMessages);
  
  if (globalStats.totalMessages >= 1) {
    console.log('   ✅ PASS: Global stats working');
  } else {
    console.log('   ❌ FAIL: Global stats not working');
  }

  // Test 3: Chat cost stats
  console.log('\\n📊 Test 3: Chat Cost Stats API');
  const chatCost = await storageManager.getChatCost(TEST_CHAT_ID);
  console.log('   Chat cost:', chatCost.totalCost);
  console.log('   Chat tokens:', chatCost.totalTokens);
  console.log('   Message count:', chatCost.messageCount);
  
  if (chatCost.messageCount >= 1 && chatCost.totalTokens === 150) {
    console.log('   ✅ PASS: Chat stats working');
  } else {
    console.log('   ❌ FAIL: Chat stats mismatch');
  }

  // Test 4: Document attribution
  console.log('\\n📊 Test 4: Document Attribution');
  const documentService = await initializeDocumentService();
  const doc = await documentService.createDocument(
    'Test Document',
    '# Test\\n\\nContent',
    TEST_AGENT_ID,
    TEST_AGENT_NAME
  );
  console.log('   Document created:', doc.id);
  console.log('   Created by:', doc.createdByAgentId);
  
  if (doc.createdByAgentId === TEST_AGENT_ID) {
    console.log('   ✅ PASS: Document attribution working');
  } else {
    console.log('   ❌ FAIL: Document attribution not set');
  }

  // Test 5: App attribution
  console.log('\\n📊 Test 5: App Attribution');
  const appService = await initializeAppService();
  const app = await appService.createApp(
    'Test App',
    'Test Description',
    [{ filename: 'index.html', content: '<html></html>' }],
    undefined,
    TEST_AGENT_ID,
    TEST_AGENT_NAME
  );
  console.log('   App created:', app.id);
  console.log('   Created by:', app.createdByAgentId);
  
  if (app.createdByAgentId === TEST_AGENT_ID) {
    console.log('   ✅ PASS: App attribution working');
  } else {
    console.log('   ❌ FAIL: App attribution not set');
  }

  // Test 6: Plan attribution  
  console.log('\\n📊 Test 6: Plan Attribution');
  const planService = await initializePlanService();
  const plan = await planService.createPlan(
    'test-plan-1',
    TEST_CHAT_ID,
    'Test Plan',
    [{ id: 's1', description: 'Step 1', status: 'pending' }],
    TEST_AGENT_ID,
    TEST_AGENT_NAME
  );
  console.log('   Plan created:', plan.planId);
  console.log('   Created by:', plan.sourceAgentId);
  
  if (plan.sourceAgentId === TEST_AGENT_ID) {
    console.log('   ✅ PASS: Plan attribution working');
  } else {
    console.log('   ❌ FAIL: Plan attribution not set');
  }

  // Test 7: Agent outputs query
  console.log('\\n📊 Test 7: Agent Outputs Query');
  const outputs = await storageManager.getAgentOutputs(TEST_AGENT_ID);
  console.log('   Documents:', outputs.documents.length);
  console.log('   Apps:', outputs.apps.length);
  console.log('   Plans:', outputs.plans.length);
  
  if (outputs.documents.length >= 1 && outputs.apps.length >= 1) {
    console.log('   ✅ PASS: Outputs query working');
  } else {
    console.log('   ❌ FAIL: Outputs not found');
  }

  // Cleanup
  db.close();
  planService.close();
  await fs.remove(TEST_DATA_PATH);
  console.log('\\n✅ All tests completed successfully!');
}

runTest().catch(err => {
  console.error('\\n❌ Test failed:', err);
  process.exit(1);
});
`;

// Write test script to temp file
const fs = require('fs');
const os = require('os');
const testPath = path.join(os.tmpdir(), 'agent-test-script.js');
fs.writeFileSync(testPath, testScript);

// Run using Electron's Node
const electronPath = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
const child = spawn(electronPath, [testPath], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit'
});

child.on('close', (code) => {
  fs.unlinkSync(testPath);
  process.exit(code);
});
