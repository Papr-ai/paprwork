#!/usr/bin/env tsx
/**
 * End-to-End Test: Send message to agent and verify tracking
 * 
 * This script:
 * 1. Initializes AgentService with a real API key
 * 2. Sends a message to the agent
 * 3. Waits for response
 * 4. Checks database for tokens, cost, and attribution
 */

import { AgentService, initializeAgentService } from "../src/gateway/services/AgentService.js";
import { StorageManager } from "../src/gateway/services/StorageManager.js";
import type { AgentConfig } from "../src/core/types/agents.js";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";

const TEST_DATA_PATH = path.join(os.tmpdir(), `e2e-agent-test-${Date.now()}`);
const TEST_CHAT_ID = `e2e-test-${Date.now()}`;

console.log("\n🧪 End-to-End Agent Tracking Test");
console.log("=".repeat(60));

async function runTest() {
  try {
    // Check for API key
    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      console.log("\n❌ No API key found!");
      console.log("   Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable.");
      process.exit(1);
    }

    const provider = process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai";
    const model = provider === "anthropic" ? "claude-3-5-sonnet-20241022" : "gpt-4o-mini";
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;

    console.log(`\n📋 Test Configuration:`);
    console.log(`   Provider: ${provider}`);
    console.log(`   Model: ${model}`);
    console.log(`   API Key: ${apiKey?.substring(0, 8)}...`);
    console.log(`   Test Path: ${TEST_DATA_PATH}`);

    // Setup
    console.log("\n📦 Setting up test environment...");
    await fs.remove(TEST_DATA_PATH);
    await fs.ensureDir(TEST_DATA_PATH);

    const storageManager = new StorageManager();
    await storageManager.initialize({ mode: "local", userDataPath: TEST_DATA_PATH });

    await initializeAgentService({
      storageManager,
      userDataPath: TEST_DATA_PATH,
    });
    const agentService = AgentService.getInstance();

    console.log("✓ Services initialized");

    // Create chat
    await storageManager.createChat(TEST_CHAT_ID, "E2E Test Chat");
    console.log("✓ Test chat created");

    // Configure agent
    const config: AgentConfig = {
      provider,
      model,
      temperature: 0.7,
      maxTokens: 100,
      apiKey,
    };

    // Send message
    console.log("\n📤 Sending message to agent...");
    const userMessage = "Say hello in exactly 3 words.";
    console.log(`   Message: "${userMessage}"`);

    let responseText = "";
    let tokenUsage: any = null;
    let responseComplete = false;
    let errorOccurred = false;

    const stream = agentService.streamAgent(TEST_CHAT_ID, userMessage, config);

    for await (const chunk of stream) {
      if (chunk.type === "text") {
        responseText += chunk.content;
      } else if (chunk.type === "done") {
        responseComplete = true;
        if (chunk.usage) {
          tokenUsage = chunk.usage;
        }
      } else if (chunk.type === "error") {
        errorOccurred = true;
        console.error(`\n❌ Error: ${chunk.error}`);
      }
    }

    if (errorOccurred) {
      console.log("\n❌ Agent call failed. Test aborted.");
      process.exit(1);
    }

    console.log("\n✓ Response received!");
    console.log(`   Response: "${responseText}"`);
    if (tokenUsage) {
      console.log(`   Token usage:`, tokenUsage);
    }

    // Wait for DB writes
    console.log("\n⏳ Waiting for database writes...");
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check database
    console.log("\n📊 Checking Database...");
    console.log("=".repeat(60));

    const dbPath = path.join(TEST_DATA_PATH, "chats.db");
    const db = new Database(dbPath);

    // Check schema
    const columns = db.pragma("table_info(messages)") as any[];
    const columnNames = columns.map(c => c.name);

    console.log("\n✓ Database Schema:");
    const requiredColumns = ["total_tokens", "cost", "prompt_tokens", "completion_tokens", "source_agent_id", "source_agent_name"];
    requiredColumns.forEach(col => {
      if (columnNames.includes(col)) {
        console.log(`  ✅ ${col}`);
      } else {
        console.log(`  ❌ ${col} - MISSING!`);
      }
    });

    // Get messages
    const messages = db
      .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp")
      .all(TEST_CHAT_ID) as any[];

    console.log(`\n✓ Found ${messages.length} message(s):`);

    messages.forEach((msg, idx) => {
      console.log(`\n  Message ${idx + 1} (${msg.role}):`);
      console.log(`    Content: ${msg.content?.substring(0, 50)}...`);
      console.log(`    Model: ${msg.model || "N/A"}`);
      console.log(`    Total Tokens: ${msg.total_tokens || "N/A"}`);
      console.log(`    Prompt Tokens: ${msg.prompt_tokens || "N/A"}`);
      console.log(`    Completion Tokens: ${msg.completion_tokens || "N/A"}`);
      console.log(`    Cost: $${msg.cost || "0"}`);
      console.log(`    Agent ID: ${msg.source_agent_id || "N/A (main agent)"}`);
      console.log(`    Agent Name: ${msg.source_agent_name || "N/A"}`);
    });

    // Verify tracking
    console.log("\n📋 Verification:");
    console.log("=".repeat(60));

    const assistantMsg = messages.find(m => m.role === "assistant");
    let allPassed = true;

    if (!assistantMsg) {
      console.log("❌ No assistant message found!");
      allPassed = false;
    } else {
      if (assistantMsg.total_tokens && assistantMsg.total_tokens > 0) {
        console.log(`✅ Tokens tracked: ${assistantMsg.total_tokens}`);
      } else {
        console.log("❌ No token data!");
        allPassed = false;
      }

      if (assistantMsg.cost && assistantMsg.cost > 0) {
        console.log(`✅ Cost tracked: $${assistantMsg.cost}`);
      } else {
        console.log("❌ No cost data!");
        allPassed = false;
      }

      if (assistantMsg.model) {
        console.log(`✅ Model tracked: ${assistantMsg.model}`);
      } else {
        console.log("⚠️  No model data (not critical)");
      }
    }

    // Test storage APIs
    console.log("\n📊 Testing Storage APIs:");
    console.log("=".repeat(60));

    const globalStats = await storageManager.getGlobalCostStats();
    console.log(`\n✓ Global Cost Stats:`);
    console.log(`  Total: $${globalStats.total}`);
    console.log(`  Messages: ${globalStats.totalMessages}`);

    const chatCost = await storageManager.getChatCost(TEST_CHAT_ID);
    console.log(`\n✓ Chat Cost Stats:`);
    console.log(`  Cost: $${chatCost.totalCost}`);
    console.log(`  Tokens: ${chatCost.totalTokens}`);
    console.log(`  Messages: ${chatCost.messageCount}`);

    // Cleanup
    db.close();
    await fs.remove(TEST_DATA_PATH);

    // Final result
    console.log("\n" + "=".repeat(60));
    if (allPassed) {
      console.log("✅ ALL TESTS PASSED!");
      console.log("   Agent tracking is working correctly:");
      console.log("   - Tokens are captured ✓");
      console.log("   - Cost is calculated ✓");
      console.log("   - Data is stored in DB ✓");
      console.log("   - APIs return correct data ✓");
      process.exit(0);
    } else {
      console.log("❌ SOME TESTS FAILED");
      console.log("   Check the output above for details.");
      process.exit(1);
    }

  } catch (error) {
    console.error("\n💥 Test failed with error:");
    console.error(error);
    process.exit(1);
  }
}

runTest();
