/**
 * Manual Test: Custom Keys in /api/bash/run
 *
 * This test verifies that mini-apps can use custom keys from Settings via
 * the /api/bash/run endpoint using ${KEY_NAME} substitution.
 *
 * Prerequisites:
 * 1. Gateway running (npm start)
 * 2. Custom key added in Settings → API Keys: TEST_KEY = "test-value-123"
 *
 * Run: node --import tsx tests/manual/bash-custom-keys.test.ts
 */

async function testBashCustomKeys() {
  const GATEWAY_URL = "http://localhost:18789";

  console.log("🧪 Testing /api/bash/run with custom keys...\n");

  // Test 1: Simple echo with custom key
  console.log("Test 1: Echo with custom key");
  try {
    const res1 = await fetch(`${GATEWAY_URL}/api/bash/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: 'echo "Key is: ${TEST_KEY}"',
      }),
    });

    const result1 = await res1.json();
    console.log("  Response:", result1);

    if (result1.stdout.includes("test-value-123")) {
      console.log("  ✅ Key substitution worked!\n");
    } else if (result1.stdout.includes("${TEST_KEY}")) {
      console.log("  ⚠️  Key not substituted (may not exist in Settings)\n");
    } else {
      console.log("  ❌ Unexpected output\n");
    }
  } catch (error) {
    console.error("  ❌ Test 1 failed:", error);
  }

  // Test 2: Command without custom keys (should work normally)
  console.log("Test 2: Command without custom keys");
  try {
    const res2 = await fetch(`${GATEWAY_URL}/api/bash/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: 'echo "No keys here"',
      }),
    });

    const result2 = await res2.json();
    console.log("  Response:", result2);

    if (result2.exitCode === 0 && result2.stdout.includes("No keys here")) {
      console.log("  ✅ Normal commands still work!\n");
    } else {
      console.log("  ❌ Normal command failed\n");
    }
  } catch (error) {
    console.error("  ❌ Test 2 failed:", error);
  }

  // Test 3: Multiple keys in one command
  console.log("Test 3: Multiple keys in one command");
  try {
    const res3 = await fetch(`${GATEWAY_URL}/api/bash/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: 'echo "TEST_KEY=${TEST_KEY} OPENAI_API_KEY=${OPENAI_API_KEY}"',
      }),
    });

    const result3 = await res3.json();
    console.log("  Response:", result3);
    console.log(
      "  Note: Check that output is sanitized (keys replaced with ***)\n",
    );
  } catch (error) {
    console.error("  ❌ Test 3 failed:", error);
  }

  // Test 4: PostgreSQL example (requires NEON_DB_URL in Settings)
  console.log("Test 4: PostgreSQL query (requires NEON_DB_URL)");
  try {
    const res4 = await fetch(`${GATEWAY_URL}/api/bash/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command:
          'psql "${NEON_DB_URL}" -c "SELECT version();" 2>&1 || echo "No NEON_DB_URL configured"',
      }),
    });

    const result4 = await res4.json();
    console.log("  Response:", result4);

    if (result4.stdout.includes("PostgreSQL")) {
      console.log("  ✅ PostgreSQL query worked!\n");
    } else if (result4.stdout.includes("No NEON_DB_URL")) {
      console.log("  ⚠️  NEON_DB_URL not configured (expected)\n");
    } else {
      console.log("  ℹ️  PostgreSQL not available or key not set\n");
    }
  } catch (error) {
    console.error("  ❌ Test 4 failed:", error);
  }

  console.log("✅ Manual tests completed!");
  console.log(
    "\nTo verify sanitization, check Gateway logs for: [Gateway] /api/bash/run using keys: ...",
  );
}

// Run tests
testBashCustomKeys().catch(console.error);
