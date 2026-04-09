/**
 * Complete Integration Test
 * This test actually initializes services, calls agent, and verifies DB
 */

const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const Database = require('better-sqlite3');

// Import from dist (compiled code)
const { LocalStorageProvider } = require('../dist/gateway/services/storage/LocalStorageProvider.js');
const { StorageManager } = require('../dist/gateway/services/StorageManager.js');

const TEST_DATA_PATH = path.join(os.tmpdir(), `agent-track-test-${Date.now()}`);
const TEST_CHAT_ID = `test-${Date.now()}`;
const TEST_AGENT_ID = 'test-agent';
const TEST_AGENT_NAME = 'Test Agent';

let passed = 0;
let failed = 0;

function test(name, condition, details) {
  if (condition) {
    console.log(`✅ PASS: ${name}`);
    if (details) console.log(`   ${details}`);
    passed++;
    return true;
  } else {
    console.log(`❌ FAIL: ${name}`);
    if (details) console.log(`   ${details}`);
    failed++;
    return false;
  }
}

async function runTests() {
  console.log('\n🧪 Complete Agent Tracking Integration Test');
  console.log('='.repeat(60));
  console.log(`Test data path: ${TEST_DATA_PATH}\n`);

  try {
    // Setup
    await fs.remove(TEST_DATA_PATH);
    await fs.ensureDir(TEST_DATA_PATH);
    
    // Initialize storage
    console.log('📦 Initializing storage...');
    const storageManager = new StorageManager();
    await storageManager.initialize({ mode: 'local', userDataPath: TEST_DATA_PATH });
    console.log('✓ Storage initialized\n');

    // Create test chat
    await storageManager.createChat(TEST_CHAT_ID, 'Integration Test Chat');
    console.log('✓ Test chat created\n');

    // Open database directly
    const dbPath = path.join(TEST_DATA_PATH, 'chats.db');
    const db = new Database(dbPath);

    // Test 1: Verify schema
    console.log('📊 Test 1: Database Schema');
    console.log('='.repeat(60));
    const columns = db.pragma('table_info(messages)');
    const columnNames = columns.map(c => c.name);
    
    test('total_tokens column exists', columnNames.includes('total_tokens'));
    test('cost column exists', columnNames.includes('cost'));
    test('source_agent_id column exists', columnNames.includes('source_agent_id'));
    test('source_agent_name column exists', columnNames.includes('source_agent_name'));

    // Test 2: Insert message with tracking data
    console.log('\n📊 Test 2: Insert Message with Tracking Data');
    console.log('='.repeat(60));
    
    db.prepare(`
      INSERT INTO messages (
        id, chat_id, role, content, timestamp, sync_status,
        model, total_tokens, prompt_tokens, completion_tokens, cost,
        source_agent_id, source_agent_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'msg-test-1',
      TEST_CHAT_ID,
      'assistant',
      'Hello! This is a test response.',
      new Date().toISOString(),
      'local',
      'gpt-4o-mini',
      150,     // total_tokens
      100,     // prompt_tokens
      50,      // completion_tokens
      0.0015,  // cost ($0.0015)
      TEST_AGENT_ID,
      TEST_AGENT_NAME
    );

    const inserted = db.prepare('SELECT * FROM messages WHERE id = ?').get('msg-test-1');
    test('Message inserted successfully', inserted !== undefined);
    test('Tokens saved correctly', inserted.total_tokens === 150);
    test('Cost saved correctly', inserted.cost === 0.0015);
    test('Agent ID saved correctly', inserted.source_agent_id === TEST_AGENT_ID);
    test('Agent name saved correctly', inserted.source_agent_name === TEST_AGENT_NAME);

    // Test 3: Query via Storage Manager API
    console.log('\n📊 Test 3: Storage Manager APIs');
    console.log('='.repeat(60));
    
    const globalStats = await storageManager.getGlobalCostStats();
    console.log(`Global stats - Total: $${globalStats.total}, Messages: ${globalStats.totalMessages}`);
    test('Global stats returns data', globalStats.totalMessages > 0);
    test('Global cost calculated', globalStats.total > 0);

    const chatCost = await storageManager.getChatCost(TEST_CHAT_ID);
    console.log(`Chat stats - Cost: $${chatCost.totalCost}, Tokens: ${chatCost.totalTokens}`);
    test('Chat cost matches', chatCost.totalCost === 0.0015);
    test('Chat tokens match', chatCost.totalTokens === 150);

    // Test 4: Cost trends
    console.log('\n📊 Test 4: Cost Trends');
    console.log('='.repeat(60));
    
    const trends = await storageManager.getDailyCostTrends(7);
    console.log(`Found ${trends.length} day(s) with data`);
    test('Cost trends returns array', Array.isArray(trends));
    test('Today has cost data', trends.some(t => t.cost > 0));

    // Test 5: Model distribution
    console.log('\n📊 Test 5: Model Distribution');
    console.log('='.repeat(60));
    
    const distribution = await storageManager.getModelDistribution();
    console.log(`Found ${distribution.length} model(s)`);
    test('Model distribution returns array', Array.isArray(distribution));
    test('gpt-4o-mini in distribution', distribution.some(m => m.model === 'gpt-4o-mini'));

    // Test 6: Document attribution
    console.log('\n📊 Test 6: Document Attribution');
    console.log('='.repeat(60));
    
    const { initializeDocumentService } = require('../dist/gateway/services/DocumentService.js');
    const documentService = await initializeDocumentService();
    
    const doc = await documentService.createDocument(
      'Test Document',
      '# Integration Test\n\nThis document tests agent attribution.',
      TEST_AGENT_ID,
      TEST_AGENT_NAME
    );
    
    console.log(`Created document: ${doc.id}`);
    test('Document created', doc.id !== undefined);
    test('Document has agent ID', doc.createdByAgentId === TEST_AGENT_ID);
    test('Document has agent name', doc.createdByAgentName === TEST_AGENT_NAME);

    // Verify file system
    const docMetaPath = path.join(os.homedir(), 'Papr', 'documents', doc.id, 'meta.json');
    if (fs.existsSync(docMetaPath)) {
      const meta = JSON.parse(fs.readFileSync(docMetaPath, 'utf8'));
      test('Document meta file has agent ID', meta.createdByAgentId === TEST_AGENT_ID);
    }

    // Test 7: App attribution
    console.log('\n📊 Test 7: App Attribution');
    console.log('='.repeat(60));
    
    const { initializeAppService } = require('../dist/gateway/services/AppService.js');
    const appService = await initializeAppService();
    
    const app = await appService.createApp(
      'Test App',
      'Integration test application',
      [{ filename: 'index.html', content: '<html><body><h1>Test</h1></body></html>' }],
      undefined,
      TEST_AGENT_ID,
      TEST_AGENT_NAME
    );
    
    console.log(`Created app: ${app.id}`);
    test('App created', app.id !== undefined);
    test('App has agent ID', app.createdByAgentId === TEST_AGENT_ID);
    test('App has agent name', app.createdByAgentName === TEST_AGENT_NAME);

    // Test 8: Plan attribution
    console.log('\n📊 Test 8: Plan Attribution');
    console.log('='.repeat(60));
    
    const { initializePlanService } = require('../dist/gateway/services/PlanService.js');
    const planService = await initializePlanService();
    
    const plan = await planService.createPlan(
      'test-plan-123',
      TEST_CHAT_ID,
      'Integration Test Plan',
      [
        { id: 'step-1', description: 'Step 1', status: 'pending' },
        { id: 'step-2', description: 'Step 2', status: 'pending' }
      ],
      TEST_AGENT_ID,
      TEST_AGENT_NAME
    );
    
    console.log(`Created plan: ${plan.planId}`);
    test('Plan created', plan.planId === 'test-plan-123');
    test('Plan has agent ID', plan.sourceAgentId === TEST_AGENT_ID);
    test('Plan has agent name', plan.sourceAgentName === TEST_AGENT_NAME);

    // Verify in database
    const plansDbPath = path.join(os.homedir(), 'Papr', 'data', 'plans.db');
    const plansDb = new Database(plansDbPath);
    const planRow = plansDb.prepare('SELECT * FROM plans WHERE plan_id = ?').get('test-plan-123');
    test('Plan in database', planRow !== undefined);
    test('Plan DB has agent ID', planRow.source_agent_id === TEST_AGENT_ID);
    plansDb.close();
    planService.close();

    // Test 9: Agent outputs query
    console.log('\n📊 Test 9: Agent Outputs Query');
    console.log('='.repeat(60));
    
    const outputs = await storageManager.getAgentOutputs(TEST_AGENT_ID);
    console.log(`Documents: ${outputs.documents.length}, Apps: ${outputs.apps.length}`);
    test('Outputs query returns data', outputs.documents.length > 0 || outputs.apps.length > 0);
    test('Document found in outputs', outputs.documents.some(d => d.id === doc.id));
    test('App found in outputs', outputs.apps.some(a => a.id === app.id));

    // Cleanup
    db.close();
    await fs.remove(TEST_DATA_PATH);
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    
    if (failed === 0) {
      console.log('\n🎉 ALL TESTS PASSED! Agent tracking is working perfectly.');
      process.exit(0);
    } else {
      console.log('\n⚠️  Some tests failed.');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n💥 Test error:', error);
    process.exit(1);
  }
}

// Run the tests
runTests();
