#!/usr/bin/env node
/**
 * Papr SDK v2.4.0 - Tool Verification Script
 * 
 * This script verifies that all new tools and parameters are properly
 * exported and have the correct schemas. Does NOT require API key.
 */

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function section(title) {
  console.log('\n' + '='.repeat(70));
  log(title, 'bold');
  console.log('='.repeat(70));
}

let passed = 0;
let failed = 0;

function test(name, condition, details = '') {
  if (condition) {
    passed++;
    log(`  ✓ ${name}`, 'green');
  } else {
    failed++;
    log(`  ✗ ${name}`, 'red');
  }
  if (details) {
    log(`    ${details}`, 'cyan');
  }
}

section('Papr SDK v2.4.0 - Tool Verification');
log('Checking tool exports and parameter schemas\n', 'cyan');

try {
  // Import the tools
  const tools = await import('../dist/core/tools/index.js');
  const paprTools = tools.paprMemoryTools || [];

  // Test 1: Tool Count
  section('TEST 1: Tool Export Verification');
  test('Total tools exported', paprTools.length === 11, `Found ${paprTools.length}/11 tools`);

  // Test 2: Existing Tools
  section('TEST 2: Existing Tools Present');
  const existingTools = [
    'add_agent_memory',
    'search_agent_memory',
    'register_schema',
    'update_schema',
    'list_schemas',
    'get_schema',
    'introspect_memory_graph',
    'query_memory_graph',
  ];

  existingTools.forEach(toolId => {
    const tool = paprTools.find(t => t.id === toolId);
    test(toolId, !!tool, tool ? `Description: ${tool.description.substring(0, 60)}...` : 'Not found');
  });

  // Test 3: New Tools
  section('TEST 3: New Tools Added');
  const newTools = ['delete_memory', 'delete_schema', 'create_entities'];
  
  newTools.forEach(toolId => {
    const tool = paprTools.find(t => t.id === toolId);
    test(toolId, !!tool, tool ? `Description: ${tool.description.substring(0, 60)}...` : 'Not found');
  });

  // Test 4: Holographic Parameters in add_agent_memory
  section('TEST 4: Holographic Parameters in add_agent_memory');
  const addTool = paprTools.find(t => t.id === 'add_agent_memory');
  
  if (addTool) {
    const schema = addTool.inputSchema.shape;
    test('enableHolographic parameter', 'enableHolographic' in schema);
    test('frequencySchemaId parameter', 'frequencySchemaId' in schema);
    
    // Check all expected fields
    const expectedFields = [
      'content', 'role', 'category', 'sourceAgentId', 'sourceAgentName',
      'runId', 'jobId', 'chatId', 'workspaceId', 'enableHolographic', 'frequencySchemaId'
    ];
    const actualFields = Object.keys(schema);
    test('All expected fields present', expectedFields.every(f => actualFields.includes(f)), 
         `Fields: ${actualFields.join(', ')}`);
  } else {
    failed++;
    log('  ✗ add_agent_memory tool not found!', 'red');
  }

  // Test 5: Holographic Config in search_agent_memory
  section('TEST 5: Holographic Config in search_agent_memory');
  const searchTool = paprTools.find(t => t.id === 'search_agent_memory');
  
  if (searchTool) {
    const schema = searchTool.inputSchema.shape;
    test('holographicConfig parameter', 'holographicConfig' in schema);
    
    if ('holographicConfig' in schema) {
      const holographicConfig = schema.holographicConfig._def.innerType.shape;
      const expectedConfigFields = [
        'enabled', 'frequencySchemaId', 'searchMode', 'scoringMethod',
        'includeFrequencyScores', 'frequencyFilters', 'hcondBoostFactor',
        'hcondBoostThreshold', 'hcondPenaltyFactor'
      ];
      
      expectedConfigFields.forEach(field => {
        test(`holographicConfig.${field}`, field in holographicConfig);
      });
      
      test('All holographic config fields present', 
           expectedConfigFields.every(f => f in holographicConfig),
           `9/9 fields: ${Object.keys(holographicConfig).join(', ')}`);
    }
  } else {
    failed++;
    log('  ✗ search_agent_memory tool not found!', 'red');
  }

  // Test 6: delete_memory Tool Structure
  section('TEST 6: delete_memory Tool Structure');
  const deleteTool = paprTools.find(t => t.id === 'delete_memory');
  
  if (deleteTool) {
    const schema = deleteTool.inputSchema.shape;
    test('Has memoryId parameter', 'memoryId' in schema);
    test('Description mentions deletion', deleteTool.description.toLowerCase().includes('delete'));
  } else {
    failed++;
    log('  ✗ delete_memory tool not found!', 'red');
  }

  // Test 7: delete_schema Tool Structure
  section('TEST 7: delete_schema Tool Structure');
  const deleteSchemaToolInst = paprTools.find(t => t.id === 'delete_schema');
  
  if (deleteSchemaToolInst) {
    const schema = deleteSchemaToolInst.inputSchema.shape;
    test('Has schemaId parameter', 'schemaId' in schema);
    test('Description mentions schema', deleteSchemaToolInst.description.toLowerCase().includes('schema'));
    test('Description mentions soft-delete or archive', 
         deleteSchemaToolInst.description.toLowerCase().includes('soft') || 
         deleteSchemaToolInst.description.toLowerCase().includes('archive'));
  } else {
    failed++;
    log('  ✗ delete_schema tool not found!', 'red');
  }

  // Test 8: create_entities Tool Structure
  section('TEST 8: create_entities Tool Structure');
  const createTool = paprTools.find(t => t.id === 'create_entities');
  
  if (createTool) {
    const schema = createTool.inputSchema.shape;
    test('Has content parameter', 'content' in schema);
    test('Has nodes parameter', 'nodes' in schema);
    test('Has relationships parameter', 'relationships' in schema);
    test('Has schemaId parameter', 'schemaId' in schema);
    test('Description mentions entities', createTool.description.toLowerCase().includes('entit'));
  } else {
    failed++;
    log('  ✗ create_entities tool not found!', 'red');
  }

  // Test 9: Tool Registry Integration
  section('TEST 9: Tool Registry Integration');
  test('paprMemoryTools exported', !!tools.paprMemoryTools);
  test('Individual tools exported', !!tools.addAgentMemoryTool && !!tools.deleteMemoryTool);
  test('Tools in allTools array', tools.allTools.some(t => t.id === 'delete_memory'));
  test('Tools in toolsByCategory.papr', 
       tools.toolsByCategory.papr.some(t => t.id === 'delete_memory'));

  // Summary
  section('TEST SUMMARY');
  const total = passed + failed;
  const passRate = ((passed / total) * 100).toFixed(1);
  
  console.log('');
  log(`Total Checks: ${total}`, 'bold');
  log(`✓ Passed: ${passed}`, 'green');
  log(`✗ Failed: ${failed}`, 'red');
  log(`Pass Rate: ${passRate}%`, passRate === '100.0' ? 'green' : 'yellow');
  console.log('\n' + '='.repeat(70));
  
  if (failed === 0) {
    log('🎉 ALL CHECKS PASSED!', 'green');
    log('All tools and parameters are correctly exported.', 'green');
    console.log('');
    log('Next Steps:', 'bold');
    log('  1. Set your PAPR_API_KEY (Settings → API Keys)', 'cyan');
    log('  2. Run: npm run test:papr-sdk', 'cyan');
    log('  3. This will test actual SDK functionality with API calls', 'cyan');
  } else {
    log('⚠ SOME CHECKS FAILED', 'yellow');
    log('Please review the failures above.', 'yellow');
  }
  
  console.log('='.repeat(70) + '\n');
  
  process.exit(failed === 0 ? 0 : 1);

} catch (error) {
  log('\n❌ Verification Error:', 'red');
  console.error(error);
  process.exit(1);
}
