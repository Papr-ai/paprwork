#!/usr/bin/env tsx
/**
 * Test Agent Attribution Tracking
 * Tests that we properly track agent attribution for documents, apps, plans, and messages
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalStorageProvider } from "../src/gateway/services/storage/LocalStorageProvider.js";
import { DocumentService } from "../src/gateway/services/DocumentService.js";
import { AppService } from "../src/gateway/services/AppService.js";
import { PlanService } from "../src/gateway/services/PlanService.js";
import type { StoredMessage } from "../src/gateway/services/storage/IStorageProvider.js";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";

const TEST_DATA_PATH = path.join(os.tmpdir(), `agent-tracking-test-${Date.now()}`);
const TEST_CHAT_ID = `tracking-test-${Date.now()}`;
const TEST_AGENT_ID = "test-agent-123";
const TEST_AGENT_NAME = "Test Agent";

describe("Agent Attribution Tracking", () => {
  let storageProvider: LocalStorageProvider;
  let documentService: DocumentService;
  let appService: AppService;
  let planService: PlanService;

  beforeEach(async () => {
    // Clean up test directory
    await fs.remove(TEST_DATA_PATH);

    // Initialize services
    storageProvider = new LocalStorageProvider(TEST_DATA_PATH);
    await storageProvider.initialize();

    documentService = new DocumentService();
    await documentService.initialize();

    appService = new AppService();
    await appService.initialize();

    planService = new PlanService();
    await planService.initialize();

    // Create test chat
    await storageProvider.createChat(TEST_CHAT_ID, "Test Chat");
  });

  afterEach(async () => {
    // Clean up
    storageProvider.close();
    planService.close();
    await fs.remove(TEST_DATA_PATH);
  });

  describe("Message Token & Cost Tracking", () => {
    it("should store tokens and cost with messages", async () => {
      const message: StoredMessage = {
        id: "msg-1",
        chat_id: TEST_CHAT_ID,
        role: "assistant",
        content: "Hello, how can I help?",
        timestamp: new Date().toISOString(),
        sync_status: "local",
        model: "gpt-5-mini",
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cost: 0.0015,
        source_agent_id: TEST_AGENT_ID,
        source_agent_name: TEST_AGENT_NAME,
      };

      await storageProvider.saveMessage(TEST_CHAT_ID, message);

      const loaded = await storageProvider.loadMessages(TEST_CHAT_ID);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].prompt_tokens).toBe(100);
      expect(loaded[0].completion_tokens).toBe(50);
      expect(loaded[0].total_tokens).toBe(150);
      expect(loaded[0].cost).toBe(0.0015);
      expect(loaded[0].source_agent_id).toBe(TEST_AGENT_ID);
      expect(loaded[0].source_agent_name).toBe(TEST_AGENT_NAME);
    });

    it("should calculate agent stats correctly", async () => {
      // Save multiple messages from the same agent
      const messages: StoredMessage[] = [
        {
          id: "msg-1",
          chat_id: TEST_CHAT_ID,
          role: "assistant",
          content: "Message 1",
          timestamp: new Date().toISOString(),
          sync_status: "local",
          model: "gpt-5-mini",
          total_tokens: 100,
          cost: 0.001,
          source_agent_id: TEST_AGENT_ID,
          tool_calls: JSON.stringify([
            { name: "read_file", args: {} },
            { name: "bash", args: {} },
          ]),
        },
        {
          id: "msg-2",
          chat_id: TEST_CHAT_ID,
          role: "assistant",
          content: "Message 2",
          timestamp: new Date().toISOString(),
          sync_status: "local",
          model: "gpt-5-mini",
          total_tokens: 200,
          cost: 0.002,
          source_agent_id: TEST_AGENT_ID,
          tool_calls: JSON.stringify([{ name: "read_file", args: {} }]),
        },
      ];

      for (const msg of messages) {
        await storageProvider.saveMessage(TEST_CHAT_ID, msg);
      }

      const stats = await storageProvider.getAgentStats(TEST_AGENT_ID);

      expect(stats.totalMessages).toBe(2);
      expect(stats.totalTokens).toBe(300);
      expect(stats.totalCost).toBeCloseTo(0.003, 4);
      expect(stats.toolCallsCount).toBe(2);
      expect(stats.avgTokensPerMessage).toBe(150);
      expect(stats.avgCostPerMessage).toBeCloseTo(0.0015, 4);
      expect(stats.mostUsedTools).toContainEqual({
        tool: "read_file",
        count: 2,
      });
      expect(stats.mostUsedTools).toContainEqual({
        tool: "bash",
        count: 1,
      });
    });

    it("should calculate global cost stats", async () => {
      const now = new Date();
      const today = now.toISOString().split("T")[0];

      const message: StoredMessage = {
        id: "msg-1",
        chat_id: TEST_CHAT_ID,
        role: "assistant",
        content: "Test",
        timestamp: now.toISOString(),
        sync_status: "local",
        model: "gpt-5-mini",
        total_tokens: 100,
        cost: 0.01,
      };

      await storageProvider.saveMessage(TEST_CHAT_ID, message);

      const stats = await storageProvider.getGlobalCostStats();

      expect(stats.today).toBeCloseTo(0.01, 4);
      expect(stats.thisWeek).toBeGreaterThanOrEqual(0.01);
      expect(stats.thisMonth).toBeGreaterThanOrEqual(0.01);
      expect(stats.total).toBeGreaterThanOrEqual(0.01);
      expect(stats.totalMessages).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Document Attribution", () => {
    it("should track agent who created document", async () => {
      const doc = await documentService.createDocument(
        "Test Document",
        "# Test Content",
        TEST_AGENT_ID,
        TEST_AGENT_NAME
      );

      expect(doc.createdByAgentId).toBe(TEST_AGENT_ID);
      expect(doc.createdByAgentName).toBe(TEST_AGENT_NAME);

      // Verify it's loaded correctly
      const loaded = await documentService.getDocument(doc.id);
      expect(loaded?.createdByAgentId).toBe(TEST_AGENT_ID);
      expect(loaded?.createdByAgentName).toBe(TEST_AGENT_NAME);
    });

    it("should query documents by agent", async () => {
      await documentService.createDocument(
        "Doc 1",
        "Content 1",
        TEST_AGENT_ID,
        TEST_AGENT_NAME
      );
      await documentService.createDocument(
        "Doc 2",
        "Content 2",
        TEST_AGENT_ID,
        TEST_AGENT_NAME
      );
      await documentService.createDocument("Doc 3", "Content 3"); // No agent

      const outputs = await storageProvider.getAgentOutputs(TEST_AGENT_ID);

      expect(outputs.documents).toHaveLength(2);
      expect(outputs.documents[0].title).toMatch(/^Doc [12]$/);
    });
  });

  describe("App Attribution", () => {
    it("should track agent who created app", async () => {
      const app = await appService.createApp(
        "Test App",
        "Test Description",
        [
          {
            filename: "index.html",
            content: "<html><body>Test</body></html>",
          },
        ],
        undefined,
        TEST_AGENT_ID,
        TEST_AGENT_NAME
      );

      expect(app.createdByAgentId).toBe(TEST_AGENT_ID);
      expect(app.createdByAgentName).toBe(TEST_AGENT_NAME);

      // Verify it's loaded correctly
      const loaded = await appService.getApp(app.id);
      expect(loaded?.createdByAgentId).toBe(TEST_AGENT_ID);
      expect(loaded?.createdByAgentName).toBe(TEST_AGENT_NAME);
    });

    it("should query apps by agent", async () => {
      await appService.createApp(
        "App 1",
        "Desc 1",
        [{ filename: "index.html", content: "<html></html>" }],
        undefined,
        TEST_AGENT_ID,
        TEST_AGENT_NAME
      );
      await appService.createApp(
        "App 2",
        "Desc 2",
        [{ filename: "index.html", content: "<html></html>" }],
        undefined,
        TEST_AGENT_ID,
        TEST_AGENT_NAME
      );
      await appService.createApp("App 3", "Desc 3", [
        { filename: "index.html", content: "<html></html>" },
      ]); // No agent

      const outputs = await storageProvider.getAgentOutputs(TEST_AGENT_ID);

      expect(outputs.apps).toHaveLength(2);
      expect(outputs.apps[0].title).toMatch(/^App [12]$/);
    });
  });

  describe("Plan Attribution", () => {
    it("should track agent who created plan", async () => {
      const plan = await planService.createPlan(
        "plan-1",
        TEST_CHAT_ID,
        "Test Plan",
        [
          { id: "step-1", description: "Step 1", status: "pending" },
          { id: "step-2", description: "Step 2", status: "pending" },
        ],
        TEST_AGENT_ID,
        TEST_AGENT_NAME
      );

      expect(plan.sourceAgentId).toBe(TEST_AGENT_ID);
      expect(plan.sourceAgentName).toBe(TEST_AGENT_NAME);

      // Verify it's loaded correctly
      const loaded = await planService.getPlan("plan-1");
      expect(loaded?.sourceAgentId).toBe(TEST_AGENT_ID);
      expect(loaded?.sourceAgentName).toBe(TEST_AGENT_NAME);
    });
  });

  describe("Cost Trends", () => {
    it("should calculate daily cost trends", async () => {
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      await storageProvider.saveMessage(TEST_CHAT_ID, {
        id: "msg-1",
        chat_id: TEST_CHAT_ID,
        role: "assistant",
        content: "Today",
        timestamp: today.toISOString(),
        sync_status: "local",
        cost: 0.05,
      });

      await storageProvider.saveMessage(TEST_CHAT_ID, {
        id: "msg-2",
        chat_id: TEST_CHAT_ID,
        role: "assistant",
        content: "Yesterday",
        timestamp: yesterday.toISOString(),
        sync_status: "local",
        cost: 0.03,
      });

      const trends = await storageProvider.getDailyCostTrends(7);

      expect(trends.length).toBeGreaterThan(0);
      const todayData = trends.find(
        (t) => t.date === today.toISOString().split("T")[0]
      );
      expect(todayData?.cost).toBeCloseTo(0.05, 4);
    });

    it("should calculate model distribution", async () => {
      await storageProvider.saveMessage(TEST_CHAT_ID, {
        id: "msg-1",
        chat_id: TEST_CHAT_ID,
        role: "assistant",
        content: "GPT message",
        timestamp: new Date().toISOString(),
        sync_status: "local",
        model: "gpt-5-mini",
        cost: 0.01,
      });

      await storageProvider.saveMessage(TEST_CHAT_ID, {
        id: "msg-2",
        chat_id: TEST_CHAT_ID,
        role: "assistant",
        content: "Claude message",
        timestamp: new Date().toISOString(),
        sync_status: "local",
        model: "claude-sonnet-4",
        cost: 0.02,
      });

      const distribution = await storageProvider.getModelDistribution();

      expect(distribution.length).toBeGreaterThan(0);
      const gptModel = distribution.find((m) => m.model === "gpt-5-mini");
      const claudeModel = distribution.find((m) => m.model === "claude-sonnet-4");

      expect(gptModel).toBeDefined();
      expect(claudeModel).toBeDefined();
      expect(gptModel?.cost).toBeCloseTo(0.01, 4);
      expect(claudeModel?.cost).toBeCloseTo(0.02, 4);
    });
  });

  describe("Agent Outputs Query", () => {
    it("should return all outputs when no agent specified", async () => {
      await documentService.createDocument("Doc 1", "Content");
      await appService.createApp("App 1", "Desc", [
        { filename: "index.html", content: "<html></html>" },
      ]);

      const outputs = await storageProvider.getAgentOutputs();

      expect(outputs.documents.length).toBeGreaterThanOrEqual(1);
      expect(outputs.apps.length).toBeGreaterThanOrEqual(1);
    });

    it("should filter outputs by agent when specified", async () => {
      await documentService.createDocument(
        "Agent Doc",
        "Content",
        TEST_AGENT_ID
      );
      await documentService.createDocument("Other Doc", "Content", "other-agent");

      const outputs = await storageProvider.getAgentOutputs(TEST_AGENT_ID);

      expect(outputs.documents).toHaveLength(1);
      expect(outputs.documents[0].title).toBe("Agent Doc");
    });
  });
});
