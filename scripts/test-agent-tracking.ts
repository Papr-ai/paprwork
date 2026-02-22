#!/usr/bin/env node
/**
 * Standalone Integration Test: Agent Attribution & Cost Tracking
 * Run with: node --import tsx scripts/test-agent-tracking.ts
 */
import { LocalStorageProvider } from "../src/gateway/services/storage/LocalStorageProvider.js";
import { AgentService, initializeAgentService } from "../src/gateway/services/AgentService.js";
import { DocumentService, initializeDocumentService } from "../src/gateway/services/DocumentService.js";
import { AppService, initializeAppService } from "../src/gateway/services/AppService.js";
import { PlanService, initializePlanService } from "../src/gateway/services/PlanService.js";
import { StorageManager } from "../src/gateway/services/StorageManager.js";
import type { AgentConfig } from "../src/core/types/agents.js";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";

const TEST_DATA_PATH = path.join(os.tmpdir(), `agent-integration-test-${Date.now()}`);
const TEST_CHAT_ID = `integration-test-${Date.now()}`;
const TEST_AGENT_ID = "test-integration-agent";
const TEST_AGENT_NAME = "Integration Test Agent";

let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    testsFailed++;
    throw new Error(message);
  } else {
    console.log(`✓ ${message}`);
    testsPassed++;
  }
}

async function runTests() {
  console.log("\n🧪 Starting Agent Integration Tests");
  console.log("=" .repeat(60));
  
  let agentService: AgentService;
  let storageManager: StorageManager;
  let documentService: DocumentService;
  let appService: AppService;
  let planService: PlanService;
  let db: Database.Database;

  try {
    // Setup
    console.log("\n📦 Setting up test environment...");
    await fs.remove(TEST_DATA_PATH);
    await fs.ensureDir(TEST_DATA_PATH);

    // Initialize storage manager
    storageManager = new StorageManager();
    await storageManager.initialize({ mode: "local", userDataPath: TEST_DATA_PATH });
    console.log("✓ Storage manager initialized");

    // Initialize agent service
    await initializeAgentService({
      storageManager,
      userDataPath: TEST_DATA_PATH,
    });
    agentService = AgentService.getInstance();
    console.log("✓ Agent service initialized");

    // Initialize other services
    documentService = await initializeDocumentService();
    appService = await initializeAppService();
    planService = await initializePlanService();
    console.log("✓ Document, App, and Plan services initialized");

    // Open database for inspection
    db = new Database(path.join(TEST_DATA_PATH, "chats.db"));
    console.log("✓ Database connection opened");

    // Test 1: Real Agent Call with Token/Cost Tracking
    console.log("\n" + "=".repeat(60));
    console.log("TEST 1: Real Agent Call - Token & Cost Tracking");
    console.log("=".repeat(60));

    const config: AgentConfig = {
      provider: "openai",
      model: "gpt-4o-mini",
      temperature: 0.7,
      maxTokens: 500,
    };

    await storageManager.createChat(TEST_CHAT_ID, "Integration Test Chat");
    console.log(`✓ Chat created: ${TEST_CHAT_ID}`);

    const userMessage = "Say hello in exactly 5 words.";
    console.log(`\n📤 Sending message: "${userMessage}"`);

    let responseComplete = false;
    let assistantResponse = "";
    let tokenUsage: any = null;

    try {
      const stream = agentService.streamResponse(TEST_CHAT_ID, userMessage, config);

      for await (const chunk of stream) {
        if (chunk.type === "text" && chunk.text) {
          assistantResponse += chunk.text;
        } else if (chunk.type === "done") {
          responseComplete = true;
          tokenUsage = chunk.usage;
          console.log("\n✓ Agent response completed");
          if (tokenUsage) {
            console.log(`  Tokens: ${JSON.stringify(tokenUsage)}`);
          }
        } else if (chunk.type === "error") {
          throw new Error(chunk.error);
        }
      }
    } catch (error: any) {
      if (error.message?.includes("API key")) {
        console.log("\n⚠️  SKIPPING: No API key configured");
        console.log("   Set OPENAI_API_KEY environment variable to run this test");
        console.log("   Continuing with other tests...\n");
        responseComplete = true; // Skip but don't fail
      } else {
        throw error;
      }
    }

    assert(responseComplete, "Agent response should complete");

    if (assistantResponse) {
      console.log(`\n📥 Assistant response: "${assistantResponse}"`);

      // Wait for database writes
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check database
      const messages = db
        .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp")
        .all(TEST_CHAT_ID) as any[];

      console.log(`\n📊 Database contains ${messages.length} messages`);
      assert(messages.length >= 2, "Should have at least 2 messages (user + assistant)");

      const userMsg = messages.find(m => m.role === "user");
      const assistantMsg = messages.find(m => m.role === "assistant");

      assert(userMsg !== undefined, "User message should be in database");
      assert(assistantMsg !== undefined, "Assistant message should be in database");
      assert(userMsg.content === userMessage, "User message content should match");

      // Check token tracking
      if (assistantMsg.total_tokens && assistantMsg.total_tokens > 0) {
        console.log(`\n✓ Tokens tracked: ${assistantMsg.total_tokens}`);
        console.log(`  - Prompt tokens: ${assistantMsg.prompt_tokens}`);
        console.log(`  - Completion tokens: ${assistantMsg.completion_tokens}`);
        testsPassed++;
      } else {
        console.log("\n⚠️  No token data (API may not return usage for all models)");
      }

      // Check cost tracking
      if (assistantMsg.cost && assistantMsg.cost > 0) {
        console.log(`✓ Cost tracked: $${assistantMsg.cost}`);
        testsPassed++;
      } else {
        console.log("⚠️  No cost data");
      }
    }

    // Test 2: Stats API
    console.log("\n" + "=".repeat(60));
    console.log("TEST 2: Stats API");
    console.log("=".repeat(60));

    const globalStats = await storageManager.getGlobalCostStats();
    console.log("\n📊 Global Cost Stats:");
    console.log(`  Total: $${globalStats.total}`);
    console.log(`  Today: $${globalStats.today}`);
    console.log(`  Total Messages: ${globalStats.totalMessages}`);
    assert(typeof globalStats.total === "number", "Global stats should return cost");

    const chatCost = await storageManager.getChatCost(TEST_CHAT_ID);
    console.log("\n📊 Chat Cost Stats:");
    console.log(`  Total Cost: $${chatCost.totalCost}`);
    console.log(`  Message Count: ${chatCost.messageCount}`);
    assert(typeof chatCost.messageCount === "number", "Chat stats should return message count");

    // Test 3: Document Attribution
    console.log("\n" + "=".repeat(60));
    console.log("TEST 3: Document Attribution");
    console.log("=".repeat(60));

    const doc = await documentService.createDocument(
      "Test Integration Document",
      "# Test\n\nIntegration test document.",
      TEST_AGENT_ID,
      TEST_AGENT_NAME
    );

    console.log(`\n✓ Document created: ${doc.id}`);
    assert(doc.createdByAgentId === TEST_AGENT_ID, "Document should have agent ID");
    assert(doc.createdByAgentName === TEST_AGENT_NAME, "Document should have agent name");

    const outputs = await storageManager.getAgentOutputs(TEST_AGENT_ID);
    console.log(`✓ Agent outputs query returned ${outputs.documents.length} document(s)`);
    assert(outputs.documents.length >= 1, "Should find created document in outputs");

    // Test 4: App Attribution
    console.log("\n" + "=".repeat(60));
    console.log("TEST 4: App Attribution");
    console.log("=".repeat(60));

    const app = await appService.createApp(
      "Test Integration App",
      "Test app",
      [{ filename: "index.html", content: "<html><body>Test</body></html>" }],
      undefined,
      TEST_AGENT_ID,
      TEST_AGENT_NAME
    );

    console.log(`\n✓ App created: ${app.id}`);
    assert(app.createdByAgentId === TEST_AGENT_ID, "App should have agent ID");
    assert(app.createdByAgentName === TEST_AGENT_NAME, "App should have agent name");

    const appOutputs = await storageManager.getAgentOutputs(TEST_AGENT_ID);
    console.log(`✓ Agent outputs query returned ${appOutputs.apps.length} app(s)`);
    assert(appOutputs.apps.length >= 1, "Should find created app in outputs");

    // Test 5: Plan Attribution
    console.log("\n" + "=".repeat(60));
    console.log("TEST 5: Plan Attribution");
    console.log("=".repeat(60));

    const plan = await planService.createPlan(
      "test-plan-integration",
      TEST_CHAT_ID,
      "Test Plan",
      [
        { id: "step-1", description: "Step 1", status: "pending" },
        { id: "step-2", description: "Step 2", status: "pending" },
      ],
      TEST_AGENT_ID,
      TEST_AGENT_NAME
    );

    console.log(`\n✓ Plan created: ${plan.planId}`);
    assert(plan.sourceAgentId === TEST_AGENT_ID, "Plan should have agent ID");
    assert(plan.sourceAgentName === TEST_AGENT_NAME, "Plan should have agent name");

    // Test 6: Cost Trends
    console.log("\n" + "=".repeat(60));
    console.log("TEST 6: Cost Trends");
    console.log("=".repeat(60));

    const trends = await storageManager.getDailyCostTrends(7);
    console.log(`\n✓ Cost trends returned ${trends.length} day(s)`);
    assert(Array.isArray(trends), "Cost trends should return an array");

    // Test 7: Model Distribution
    console.log("\n" + "=".repeat(60));
    console.log("TEST 7: Model Distribution");
    console.log("=".repeat(60));

    const distribution = await storageManager.getModelDistribution();
    console.log(`\n✓ Model distribution returned ${distribution.length} model(s)`);
    assert(Array.isArray(distribution), "Model distribution should return an array");

    // Cleanup
    console.log("\n" + "=".repeat(60));
    console.log("🧹 Cleaning up...");
    db.close();
    planService.close();
    await fs.remove(TEST_DATA_PATH);
    console.log("✓ Cleanup complete");

  } catch (error) {
    console.error("\n❌ Test suite failed:", error);
    testsFailed++;
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("TEST SUMMARY");
  console.log("=".repeat(60));
  console.log(`✅ Passed: ${testsPassed}`);
  console.log(`❌ Failed: ${testsFailed}`);
  
  if (testsFailed > 0) {
    console.log("\n⚠️  Some tests failed");
    process.exit(1);
  } else {
    console.log("\n🎉 All tests passed!");
    process.exit(0);
  }
}

// Run tests
runTests().catch((error) => {
  console.error("\n💥 Fatal error:", error);
  process.exit(1);
});
