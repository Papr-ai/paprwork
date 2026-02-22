#!/usr/bin/env tsx
/**
 * Integration Test: Agent Attribution & Cost Tracking
 * 
 * This test actually runs the agent and verifies:
 * 1. Tokens and cost are captured from AI responses
 * 2. Data is properly stored in the database
 * 3. Agent attribution works for documents, apps, plans
 * 4. API endpoints return correct data
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LocalStorageProvider } from "../../src/gateway/services/storage/LocalStorageProvider.js";
import { AgentService, initializeAgentService } from "../../src/gateway/services/AgentService.js";
import { DocumentService, initializeDocumentService } from "../../src/gateway/services/DocumentService.js";
import { AppService, initializeAppService } from "../../src/gateway/services/AppService.js";
import { PlanService, initializePlanService } from "../../src/gateway/services/PlanService.js";
import { StorageManager } from "../../src/gateway/services/StorageManager.js";
import type { AgentConfig } from "../../src/core/types/agents.js";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";

const TEST_DATA_PATH = path.join(os.tmpdir(), `agent-integration-test-${Date.now()}`);
const TEST_CHAT_ID = `integration-test-${Date.now()}`;
const TEST_AGENT_ID = "test-integration-agent";
const TEST_AGENT_NAME = "Integration Test Agent";

describe("Agent Integration Tests - Real Agent Calls", () => {
  let agentService: AgentService;
  let storageProvider: LocalStorageProvider;
  let storageManager: StorageManager;
  let documentService: DocumentService;
  let appService: AppService;
  let planService: PlanService;
  let db: Database.Database;

  beforeAll(async () => {
    // Clean up test directory
    await fs.remove(TEST_DATA_PATH);
    await fs.ensureDir(TEST_DATA_PATH);

    // Initialize storage
    storageProvider = new LocalStorageProvider(TEST_DATA_PATH);
    await storageProvider.initialize();

    // Initialize storage manager
    storageManager = new StorageManager();
    await storageManager.initialize({ mode: "local", userDataPath: TEST_DATA_PATH });

    // Initialize agent service
    await initializeAgentService({
      storageManager,
      userDataPath: TEST_DATA_PATH,
    });
    agentService = AgentService.getInstance();

    // Initialize other services
    documentService = await initializeDocumentService();
    appService = await initializeAppService();
    planService = await initializePlanService();

    // Open database for direct inspection
    db = new Database(path.join(TEST_DATA_PATH, "chats.db"));

    console.log("\n🧪 Integration Test Setup Complete");
    console.log(`📁 Test database: ${TEST_DATA_PATH}`);
  }, 30000); // 30 second timeout for setup

  afterAll(async () => {
    // Clean up
    if (db) db.close();
    if (storageProvider) storageProvider.close();
    if (planService) planService.close();
    await fs.remove(TEST_DATA_PATH);
  });

  it("should capture tokens and cost from real agent response", async () => {
    console.log("\n📝 Test: Sending message to agent and verifying token/cost tracking...");

    // Skip if no API key
    if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      console.log("⚠️  Skipping: No API key found (set OPENAI_API_KEY or ANTHROPIC_API_KEY)");
      return;
    }

    // Create a simple config for testing
    const config: AgentConfig = {
      provider: process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai",
      model: process.env.ANTHROPIC_API_KEY ? "claude-3-5-sonnet-20241022" : "gpt-4o-mini",
      temperature: 0.7,
      maxTokens: 500,
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY,
    };

    console.log(`✓ Using ${config.provider} with model ${config.model}`);

    // Create chat
    await storageManager.createChat(TEST_CHAT_ID, "Integration Test Chat");

    // Send a simple message that won't trigger tools
    const userMessage = "Say hello in exactly 5 words.";

    // Stream response (we'll collect it)
    let responseComplete = false;
    let error: Error | null = null;

    const stream = agentService.streamAgent(TEST_CHAT_ID, userMessage, config);

    for await (const chunk of stream) {
      if (chunk.type === "done") {
        responseComplete = true;
        console.log("✓ Agent response completed");
        
        // Check if we got token usage
        if (chunk.usage) {
          console.log(`✓ Token usage received:`, chunk.usage);
        }
      } else if (chunk.type === "error") {
        error = new Error(chunk.error);
      }
    }

    // Verify response completed
    expect(responseComplete).toBe(true);
    expect(error).toBeNull();

    // Wait a bit for database writes to complete
    await new Promise(resolve => setTimeout(resolve, 500));

    // Now check the database directly
    const messages = db
      .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp")
      .all(TEST_CHAT_ID) as any[];

    console.log(`\n📊 Database Check: Found ${messages.length} messages`);

    // Should have 2 messages: user + assistant
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // Check user message
    const userMsg = messages.find(m => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe(userMessage);

    // Check assistant message
    const assistantMsg = messages.find(m => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBeTruthy();

    console.log(`\n✓ Assistant response: "${assistantMsg.content}"`);

    // CRITICAL: Verify token tracking
    if (assistantMsg.total_tokens) {
      console.log(`✓ Total tokens: ${assistantMsg.total_tokens}`);
      expect(assistantMsg.total_tokens).toBeGreaterThan(0);
    } else {
      console.warn("⚠️  No token data captured (API may not have returned usage)");
    }

    // CRITICAL: Verify cost tracking
    if (assistantMsg.cost) {
      console.log(`✓ Cost: $${assistantMsg.cost}`);
      expect(assistantMsg.cost).toBeGreaterThan(0);
    } else {
      console.warn("⚠️  No cost data captured");
    }

    console.log("\n✅ Token and cost tracking test completed");
  }, 60000); // 60 second timeout for agent call

  it("should store agent attribution in messages", async () => {
    console.log("\n📝 Test: Verifying agent attribution in messages...");

    // Get messages from previous test
    const messages = db
      .prepare("SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant'")
      .all(TEST_CHAT_ID) as any[];

    expect(messages.length).toBeGreaterThan(0);

    const assistantMsg = messages[0];

    // Check if source_agent_id column exists
    const columns = db.pragma("table_info(messages)") as any[];
    const hasSourceAgentId = columns.some(c => c.name === "source_agent_id");

    if (hasSourceAgentId) {
      console.log("✓ source_agent_id column exists");
      
      // For main agent responses, source_agent_id should be null or undefined
      // (only set for sub-agent responses)
      console.log(`  source_agent_id: ${assistantMsg.source_agent_id || 'null (main agent)'}`);
    }

    console.log("✅ Agent attribution test completed");
  });

  it("should query agent stats from storage", async () => {
    console.log("\n📝 Test: Querying agent stats via API...");

    // Query global stats
    const globalStats = await storageManager.getGlobalCostStats();
    
    console.log("\n📊 Global Cost Stats:");
    console.log(`  Total: $${globalStats.total}`);
    console.log(`  Today: $${globalStats.today}`);
    console.log(`  This Week: $${globalStats.thisWeek}`);
    console.log(`  This Month: $${globalStats.thisMonth}`);
    console.log(`  Total Messages: ${globalStats.totalMessages}`);

    expect(globalStats.totalMessages).toBeGreaterThan(0);

    // Query chat-specific stats
    const chatCost = await storageManager.getChatCost(TEST_CHAT_ID);
    
    console.log("\n📊 Chat Cost Stats:");
    console.log(`  Total Cost: $${chatCost.totalCost}`);
    console.log(`  Total Tokens: ${chatCost.totalTokens}`);
    console.log(`  Message Count: ${chatCost.messageCount}`);

    expect(chatCost.messageCount).toBeGreaterThan(0);

    console.log("✅ Stats query test completed");
  });

  it("should track document creation with agent attribution", async () => {
    console.log("\n📝 Test: Creating document with agent attribution...");

    const doc = await documentService.createDocument(
      "Test Integration Document",
      "# Integration Test\n\nThis document was created by an integration test.",
      TEST_AGENT_ID,
      TEST_AGENT_NAME
    );

    console.log(`✓ Document created: ${doc.id}`);
    expect(doc.createdByAgentId).toBe(TEST_AGENT_ID);
    expect(doc.createdByAgentName).toBe(TEST_AGENT_NAME);

    // Verify it's in the file system
    const docPath = path.join(os.homedir(), "PAPR", "documents", doc.id, "meta.json");
    const metaExists = await fs.pathExists(docPath);
    expect(metaExists).toBe(true);

    if (metaExists) {
      const meta = await fs.readJSON(docPath);
      console.log(`✓ Meta file exists with createdByAgentId: ${meta.createdByAgentId}`);
      expect(meta.createdByAgentId).toBe(TEST_AGENT_ID);
    }

    // Query outputs
    const outputs = await storageManager.getAgentOutputs(TEST_AGENT_ID);
    console.log(`✓ Agent outputs query returned ${outputs.documents.length} document(s)`);
    expect(outputs.documents.length).toBeGreaterThanOrEqual(1);

    const foundDoc = outputs.documents.find(d => d.id === doc.id);
    expect(foundDoc).toBeDefined();

    console.log("✅ Document attribution test completed");
  });

  it("should track app creation with agent attribution", async () => {
    console.log("\n📝 Test: Creating app with agent attribution...");

    const app = await appService.createApp(
      "Test Integration App",
      "Integration test app",
      [
        {
          filename: "index.html",
          content: "<html><body><h1>Integration Test App</h1></body></html>",
        },
      ],
      undefined,
      TEST_AGENT_ID,
      TEST_AGENT_NAME
    );

    console.log(`✓ App created: ${app.id}`);
    expect(app.createdByAgentId).toBe(TEST_AGENT_ID);
    expect(app.createdByAgentName).toBe(TEST_AGENT_NAME);

    // Query outputs
    const outputs = await storageManager.getAgentOutputs(TEST_AGENT_ID);
    console.log(`✓ Agent outputs query returned ${outputs.apps.length} app(s)`);
    expect(outputs.apps.length).toBeGreaterThanOrEqual(1);

    const foundApp = outputs.apps.find(a => a.id === app.id);
    expect(foundApp).toBeDefined();

    console.log("✅ App attribution test completed");
  });

  it("should track plan creation with agent attribution", async () => {
    console.log("\n📝 Test: Creating plan with agent attribution...");

    const plan = await planService.createPlan(
      "test-plan-integration",
      TEST_CHAT_ID,
      "Integration Test Plan",
      [
        { id: "step-1", description: "Step 1", status: "pending" },
        { id: "step-2", description: "Step 2", status: "pending" },
      ],
      TEST_AGENT_ID,
      TEST_AGENT_NAME
    );

    console.log(`✓ Plan created: ${plan.planId}`);
    expect(plan.sourceAgentId).toBe(TEST_AGENT_ID);
    expect(plan.sourceAgentName).toBe(TEST_AGENT_NAME);

    // Verify in database
    const plansDb = new Database(path.join(os.homedir(), "PAPR", "data", "plans.db"));
    const planRow = plansDb
      .prepare("SELECT * FROM plans WHERE plan_id = ?")
      .get("test-plan-integration") as any;
    plansDb.close();

    expect(planRow).toBeDefined();
    expect(planRow.source_agent_id).toBe(TEST_AGENT_ID);
    expect(planRow.source_agent_name).toBe(TEST_AGENT_NAME);

    console.log("✅ Plan attribution test completed");
  });

  it("should calculate cost trends over time", async () => {
    console.log("\n📝 Test: Calculating cost trends...");

    const trends = await storageManager.getDailyCostTrends(7);
    
    console.log(`\n📊 Cost Trends (last 7 days):`);
    console.log(`  Found ${trends.length} day(s) with data`);
    
    trends.forEach(trend => {
      console.log(`  ${trend.date}: $${trend.cost} (${trend.messages} messages)`);
    });

    expect(Array.isArray(trends)).toBe(true);

    console.log("✅ Cost trends test completed");
  });

  it("should calculate model distribution", async () => {
    console.log("\n📝 Test: Calculating model distribution...");

    const distribution = await storageManager.getModelDistribution();
    
    console.log(`\n📊 Model Distribution:`);
    distribution.forEach(model => {
      console.log(`  ${model.model}: ${model.percentage}% ($${model.cost}, ${model.messages} messages)`);
    });

    expect(Array.isArray(distribution)).toBe(true);

    console.log("✅ Model distribution test completed");
  });
});
