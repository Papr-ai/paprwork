#!/usr/bin/env node
/**
 * Test script to verify plan enforcement behavior
 * Tests that duplicate plans are blocked at tool level
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testPlanEnforcement() {
  console.log('🧪 Testing Plan Enforcement\n');
  
  // Setup test chat ID
  const testChatId = `test-${Date.now()}`;
  console.log(`Test Chat ID: ${testChatId}\n`);
  
  try {
    // Import after setting up paths
    const { createPlanTool, updatePlanTool, deletePlanTool } = await import('../dist/core/tools/planning.js');
    const { setCurrentChatId } = await import('../dist/core/tools/context.js');
    
    // Set context
    setCurrentChatId(testChatId);
    
    // Test 1: Create first plan (should succeed)
    console.log('Test 1: Create first plan');
    const result1 = await createPlanTool.execute({
      chatId: testChatId,
      title: 'Build Dashboard',
      steps: [
        { id: 'design', description: 'Design UI layout' },
        { id: 'build', description: 'Build components' },
        { id: 'test', description: 'Test functionality' }
      ]
    });
    
    const parsed1 = JSON.parse(result1);
    console.log(`✓ Result: ${parsed1.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`  Message: ${parsed1.message.split('\n')[0]}`);
    console.log(`  Plan ID: ${parsed1.data.planId}\n`);
    
    if (!parsed1.success) {
      console.error('❌ First plan creation failed!');
      return;
    }
    
    const planId = parsed1.data.planId;
    
    // Test 2: Try to create duplicate plan (should return existing)
    console.log('Test 2: Try to create duplicate plan');
    const result2 = await createPlanTool.execute({
      chatId: testChatId,
      title: 'Different Task',
      steps: [
        { id: 'step1', description: 'Some step' }
      ]
    });
    
    const parsed2 = JSON.parse(result2);
    console.log(`✓ Result: ${parsed2.success ? 'SUCCESS' : 'PREVENTED (expected)'}`);
    console.log(`  Existing Plan: ${parsed2.existingPlan ? 'YES (expected)' : 'NO'}`);
    console.log(`  Message: ${parsed2.message.split('\n')[0]}`);
    console.log(`  Returned Plan: ${parsed2.data.title}\n`);
    
    if (parsed2.success || !parsed2.existingPlan) {
      console.error('❌ Duplicate plan was NOT prevented!');
      return;
    }
    
    // Test 3: Update plan progress
    console.log('Test 3: Update plan progress');
    const result3 = await updatePlanTool.execute({
      planId: planId,
      updates: [
        { stepId: 'design', status: 'completed' },
        { stepId: 'build', status: 'in_progress' }
      ]
    });
    
    const parsed3 = JSON.parse(result3);
    console.log(`✓ Result: ${parsed3.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`  Message: ${parsed3.message.split('\n')[0]}\n`);
    
    // Test 4: Delete plan
    console.log('Test 4: Delete plan to start fresh');
    const result4 = await deletePlanTool.execute({
      planId: planId
    });
    
    const parsed4 = JSON.parse(result4);
    console.log(`✓ Result: ${parsed4.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`  Message: ${parsed4.message.split('\n')[0]}\n`);
    
    // Test 5: Create new plan after deletion (should succeed)
    console.log('Test 5: Create new plan after deletion');
    const result5 = await createPlanTool.execute({
      chatId: testChatId,
      title: 'New Task After Delete',
      steps: [
        { id: 'step1', description: 'New step' }
      ]
    });
    
    const parsed5 = JSON.parse(result5);
    console.log(`✓ Result: ${parsed5.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`  Message: ${parsed5.message.split('\n')[0]}`);
    console.log(`  Plan ID: ${parsed5.data.planId}\n`);
    
    // Summary
    console.log('━'.repeat(50));
    console.log('📊 Test Summary\n');
    console.log(`✅ Create first plan: ${parsed1.success ? 'PASS' : 'FAIL'}`);
    console.log(`✅ Block duplicate plan: ${!parsed2.success && parsed2.existingPlan ? 'PASS' : 'FAIL'}`);
    console.log(`✅ Update plan: ${parsed3.success ? 'PASS' : 'FAIL'}`);
    console.log(`✅ Delete plan: ${parsed4.success ? 'PASS' : 'FAIL'}`);
    console.log(`✅ Create after delete: ${parsed5.success ? 'PASS' : 'FAIL'}`);
    
    const allPassed = parsed1.success && 
                      !parsed2.success && parsed2.existingPlan &&
                      parsed3.success &&
                      parsed4.success &&
                      parsed5.success;
    
    console.log(`\n${allPassed ? '✅ All tests PASSED!' : '❌ Some tests FAILED!'}`);
    
    // Cleanup
    console.log('\n🧹 Cleaning up test data...');
    const { deletePlan } = await import('../dist/gateway/services/PlanService.js');
    await deletePlanTool.execute({ planId: parsed5.data.planId });
    console.log('✓ Cleanup complete\n');
    
  } catch (error) {
    console.error('❌ Test error:', error);
    process.exit(1);
  }
}

testPlanEnforcement().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
