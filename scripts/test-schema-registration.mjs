#!/usr/bin/env node

/**
 * Test script for Papr Memory schema registration fix
 * 
 * Tests that node_types and relationship_types properly persist when registering schemas.
 */

import Papr from "@papr/memory";

async function testSchemaRegistration() {
  console.log("🧪 Testing Papr Memory Schema Registration Fix\n");

  // Get API key from environment
  const apiKey = process.env.PAPR_API_KEY;
  if (!apiKey) {
    console.error("❌ PAPR_API_KEY not found in environment");
    process.exit(1);
  }

  const client = new Papr({ xAPIKey: apiKey });

  try {
    // Test 1: Register a complete schema
    console.log("📝 Test 1: Register schema with node types and relationships...");
    const testSchemaName = `Test Schema ${Date.now()}`;
    
    const createResponse = await client.schemas.create({
      name: testSchemaName,
      description: "Test schema to verify node_types persist",
      status: "draft", // Don't activate (keep as test)
      scope: "namespace",
      node_types: {
        "Company": {
          name: "Company",
          label: "Company",
          description: "A business entity",
          properties: {
            "name": {
              type: "string",
              required: true,
              description: "Company name"
            },
            "industry": {
              type: "string",
              description: "Industry sector"
            }
          },
          resolution_policy: "upsert",
          unique_identifiers: ["name"]
        },
        "Contact": {
          name: "Contact",
          label: "Contact",
          description: "A person",
          properties: {
            "name": { type: "string", required: true },
            "email": { type: "string" }
          },
          resolution_policy: "upsert",
          unique_identifiers: ["email"]
        }
      },
      relationship_types: {
        "WORKS_AT": {
          name: "WORKS_AT",
          label: "Works At",
          description: "Person works at a company",
          allowed_source_types: ["Contact"],
          allowed_target_types: ["Company"],
          cardinality: "many-to-one"
        }
      }
    });

    const schemaId = createResponse.data?.id;
    if (!schemaId) {
      console.error("❌ Schema creation failed - no schema ID returned");
      console.error("Response:", JSON.stringify(createResponse, null, 2));
      process.exit(1);
    }
    console.log(`✅ Schema created: ${schemaId}\n`);

    // Test 2: Retrieve the schema and verify node types persisted
    console.log("🔍 Test 2: Retrieve schema and verify node_types persisted...");
    const retrieveResponse = await client.schemas.retrieve(schemaId);
    
    const nodeTypes = retrieveResponse.data?.node_types || {};
    const relationshipTypes = retrieveResponse.data?.relationship_types || {};
    
    const nodeTypeCount = Object.keys(nodeTypes).length;
    const relTypeCount = Object.keys(relationshipTypes).length;
    
    console.log(`   Node types: ${nodeTypeCount}`);
    console.log(`   Relationship types: ${relTypeCount}`);
    
    if (nodeTypeCount === 0) {
      console.error("\n❌ FAIL: Node types did not persist (empty object)");
      console.error("Schema data:", JSON.stringify(retrieveResponse.data, null, 2));
      process.exit(1);
    }
    
    if (nodeTypeCount !== 2) {
      console.error(`\n❌ FAIL: Expected 2 node types, got ${nodeTypeCount}`);
      process.exit(1);
    }
    
    if (relTypeCount !== 1) {
      console.error(`\n❌ FAIL: Expected 1 relationship type, got ${relTypeCount}`);
      process.exit(1);
    }
    
    // Verify specific node types
    if (!nodeTypes["Company"]) {
      console.error("\n❌ FAIL: Company node type missing");
      process.exit(1);
    }
    
    if (!nodeTypes["Contact"]) {
      console.error("\n❌ FAIL: Contact node type missing");
      process.exit(1);
    }
    
    console.log("✅ Node types persisted correctly\n");
    
    // Test 3: Update schema (change status to active)
    console.log("📝 Test 3: Update schema status to active...");
    const updateResponse = await client.schemas.update(schemaId, {
      status: "active"
    });
    
    if (updateResponse.data?.status !== "active") {
      console.error("❌ Schema update failed - status not changed");
      process.exit(1);
    }
    console.log("✅ Schema updated to active\n");
    
    // Test 4: Clean up - archive the test schema
    console.log("🧹 Test 4: Clean up - archive test schema...");
    await client.schemas.update(schemaId, {
      status: "archived"
    });
    console.log("✅ Test schema archived\n");
    
    // Final summary
    console.log("=" .repeat(60));
    console.log("✅ ALL TESTS PASSED");
    console.log("=" .repeat(60));
    console.log("\nVerified:");
    console.log("  ✓ Schema creation with node_types");
    console.log("  ✓ Node types persist correctly");
    console.log("  ✓ Relationship types persist correctly");
    console.log("  ✓ Schema updates work");
    console.log("\nThe register_schema tool fix is working correctly! 🎉\n");
    
  } catch (error) {
    console.error("\n❌ Test failed with error:");
    console.error(error);
    process.exit(1);
  }
}

// Run tests
testSchemaRegistration();
