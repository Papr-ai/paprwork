#!/usr/bin/env node

/**
 * Test script for /api/jobs/create endpoint
 * 
 * Tests:
 * 1. Create a simple bash job
 * 2. Verify rate limiting (10 jobs/min)
 * 3. Test command size validation
 */

const GATEWAY_URL = 'http://localhost:18789';

async function testJobCreation() {
  console.log('🧪 Testing /api/jobs/create endpoint\n');

  // Test 1: Create a simple bash job
  console.log('Test 1: Create simple bash job');
  try {
    const res = await fetch(`${GATEWAY_URL}/api/jobs/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test Job from Mini-App',
        type: 'bash',
        command: 'echo "Hello from mini-app created job"',
        appId: 'test-mini-app'
      })
    });

    if (!res.ok) {
      const error = await res.json();
      console.error('❌ Failed:', error);
      return false;
    }

    const result = await res.json();
    console.log('✅ Success:', result);
    console.log(`   Job ID: ${result.jobId}`);
    console.log(`   Name: ${result.name}`);
    console.log(`   Type: ${result.type}\n`);

    // Clean up: delete the test job
    const jobId = result.jobId;
    console.log('🧹 Cleaning up test job...');
    const deleteRes = await fetch(`${GATEWAY_URL}/api/jobs/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, deleteFiles: true })
    });
    if (deleteRes.ok) {
      console.log('✅ Test job deleted\n');
    }
  } catch (error) {
    console.error('❌ Test 1 failed:', error.message);
    return false;
  }

  // Test 2: Rate limiting
  console.log('Test 2: Rate limiting (create 11 jobs quickly)');
  const appId = `test-rate-limit-${Date.now()}`;
  let successCount = 0;
  let rateLimitHit = false;
  const jobIds = [];

  for (let i = 1; i <= 11; i++) {
    try {
      const res = await fetch(`${GATEWAY_URL}/api/jobs/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Rate Limit Test ${i}`,
          type: 'bash',
          command: `echo "Test ${i}"`,
          appId
        })
      });

      if (res.status === 429) {
        const error = await res.json();
        console.log(`✅ Rate limit triggered on job ${i}: ${error.error}`);
        rateLimitHit = true;
        break;
      }

      if (res.ok) {
        const result = await res.json();
        jobIds.push(result.jobId);
        successCount++;
      }
    } catch (error) {
      console.error(`   Job ${i} error:`, error.message);
    }
  }

  console.log(`   Created ${successCount} jobs before rate limit`);
  if (rateLimitHit) {
    console.log('✅ Rate limiting works!\n');
  } else {
    console.log('⚠️  Rate limit not hit (unexpected)\n');
  }

  // Clean up rate limit test jobs
  console.log('🧹 Cleaning up rate limit test jobs...');
  for (const jobId of jobIds) {
    try {
      await fetch(`${GATEWAY_URL}/api/jobs/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, deleteFiles: true })
      });
    } catch (e) {
      // Ignore cleanup errors
    }
  }
  console.log('✅ Cleaned up\n');

  // Test 3: Command size validation
  console.log('Test 3: Command size validation (>100KB)');
  try {
    const largeCommand = 'echo "' + 'x'.repeat(100001) + '"';
    const res = await fetch(`${GATEWAY_URL}/api/jobs/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Large Command Test',
        type: 'bash',
        command: largeCommand,
        appId: 'test-size-validation'
      })
    });

    if (res.status === 400) {
      const error = await res.json();
      if (error.error.includes('too large')) {
        console.log('✅ Size validation works:', error.error, '\n');
      } else {
        console.log('⚠️  Got 400 but unexpected error:', error.error, '\n');
      }
    } else {
      console.log('⚠️  Size validation did not trigger (unexpected)\n');
    }
  } catch (error) {
    console.error('❌ Test 3 failed:', error.message);
  }

  console.log('🎉 All tests completed!');
  return true;
}

// Check if gateway is running
async function checkGateway() {
  try {
    const res = await fetch(`${GATEWAY_URL}/health`);
    if (res.ok) {
      return true;
    }
  } catch (error) {
    return false;
  }
  return false;
}

async function main() {
  console.log('Checking if Gateway is running...');
  const isRunning = await checkGateway();
  
  if (!isRunning) {
    console.error('❌ Gateway is not running at', GATEWAY_URL);
    console.error('   Start the app with: npm start');
    process.exit(1);
  }

  console.log('✅ Gateway is running\n');
  
  const success = await testJobCreation();
  process.exit(success ? 0 : 1);
}

main();
