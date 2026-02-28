#!/usr/bin/env tsx
/**
 * Test PAPR Memory Schema Tools
 * 
 * Tests the new list_schemas and register_schema tools
 */

import * as dotenv from "dotenv";
import {
  listSchemasTool,
  registerSchemaTool,
} from "../src/core/tools/paprMemory.js";

// Load environment variables
dotenv.config();

async function testSchemaTools() {
  console.log("🧪 Testing PAPR Memory Schema Tools\n");

  // Check if API key is configured
  if (!process.env.PAPR_API_KEY) {
    console.log("⚠️  PAPR_API_KEY not found in environment");
    console.log("⚠️  Set PAPR_API_KEY in .env file to run this test");
    console.log("⚠️  Skipping test...\n");
    return;
  }

  try {
    // Test 1: List existing schemas
    console.log("📋 Test 1: Listing existing schemas...");
    const listResult = await listSchemasTool.execute({});
    console.log("✅ List schemas result:", JSON.stringify(listResult, null, 2));
    console.log(
      `Found ${listResult.data?.data?.length ?? 0} schema(s)\n`,
    );

    // Test 2: List schemas filtered by status
    console.log("📋 Test 2: Listing active schemas...");
    const listActiveResult = await listSchemasTool.execute({
      statusFilter: "active",
    });
    console.log(
      "✅ List active schemas result:",
      JSON.stringify(listActiveResult, null, 2),
    );
    console.log(
      `Found ${listActiveResult.data?.data?.length ?? 0} active schema(s)\n`,
    );

    // Test 3: Register a new schema (optional - commented out to avoid creating test data)
    console.log(
      "📝 Test 3: Register new schema (skipped - uncomment to test creation)",
    );
    /*
    const registerResult = await registerSchemaTool.execute({
      name: "test_schema_" + Date.now(),
      description: "Test schema created by integration test",
    });
    console.log(
      "✅ Register schema result:",
      JSON.stringify(registerResult, null, 2),
    );
    */

    console.log("\n✅ All schema tool tests completed successfully!");
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      console.error("Stack trace:", error.stack);
    }
    process.exit(1);
  }
}

testSchemaTools().catch(console.error);
