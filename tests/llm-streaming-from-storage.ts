/**
 * LLM Streaming Tests (Using Stored Keys)
 * 
 * Tests streaming functionality using keys from CustomKeysStorage
 * Run with: npm run test:llm-storage
 */

import { MastraAgent } from "../src/core/agents/MastraAgent.js";
import { CustomKeysStorage } from "../src/core/storage/CustomKeysStorage.js";
import type { AgentConfigInternal } from "../src/core/types/agents.js";
import os from "os";
import path from "path";

// Test configuration
const TEST_USER_DATA = path.join(os.tmpdir(), "paprwork-test-llm");
const TEST_MESSAGE = "Say 'Hello World' and nothing else.";

// Test models for each provider
const TEST_MODELS = {
  anthropic: {
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    keyName: "ANTHROPIC_API_KEY",
  },
  openai: {
    model: "gpt-5-2",
    provider: "openai",
    keyName: "OPENAI_API_KEY",
  },
  google: {
    model: "gemini-2-5-flash",
    provider: "google",
    keyName: "GOOGLE_API_KEY",
  },
};

/**
 * Test streaming for a specific provider
 */
async function testProviderStreaming(
  providerName: string,
  modelConfig: { model: string; provider: string; keyName: string },
  apiKey: string,
): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing ${providerName.toUpperCase()} (${modelConfig.model})`);
  console.log("=".repeat(60));

  try {
    // Create agent
    const agent = new MastraAgent(TEST_USER_DATA);
    await agent.initialize();

    // Create config (Internal config with API key)
    const config: AgentConfigInternal = {
      model: modelConfig.model,
      provider: modelConfig.provider as "anthropic" | "openai" | "google",
      apiKey,
      systemPrompt: "You are a helpful assistant.",
      maxSteps: 1,
    };

    const sessionId = `test-${providerName}-${Date.now()}`;

    console.log(`\n📤 Sending: "${TEST_MESSAGE}"`);
    console.log(`⏳ Streaming response...`);

    let chunkCount = 0;
    let textContent = "";
    let thinkingContent = "";
    let toolCallCount = 0;
    const startTime = Date.now();

    // Stream response
    for await (const chunk of agent.stream(sessionId, TEST_MESSAGE, config)) {
      chunkCount++;

      switch (chunk.type) {
        case "text-delta":
          if (chunk.payload && typeof chunk.payload === "object") {
            const text = (chunk.payload as { text?: string }).text || "";
            textContent += text;
            process.stdout.write(text);
          }
          break;

        case "reasoning-delta":
          if (chunk.payload && typeof chunk.payload === "object") {
            const thinking = (chunk.payload as { thinking?: string }).thinking || "";
            thinkingContent += thinking;
          }
          break;

        case "tool-call":
          toolCallCount++;
          if (chunk.payload && typeof chunk.payload === "object") {
            const toolPayload = chunk.payload as { name?: string };
            console.log(`\n🔧 Tool call: ${toolPayload.name || "unknown"}`);
          }
          break;

        case "error":
          if (chunk.payload && typeof chunk.payload === "object") {
            const errorMsg = (chunk.payload as { error?: string }).error || "Unknown error";
            console.error(`\n❌ Error chunk: ${errorMsg}`);
          }
          break;
      }
    }

    const duration = Date.now() - startTime;

    // Results
    console.log(`\n\n${"─".repeat(60)}`);
    console.log("📊 RESULTS:");
    console.log(`   ✅ Status: Success`);
    console.log(`   📦 Total chunks: ${chunkCount}`);
    console.log(`   📝 Text length: ${textContent.length} chars`);
    console.log(`   💭 Thinking length: ${thinkingContent.length} chars`);
    console.log(`   🔧 Tool calls: ${toolCallCount}`);
    console.log(`   ⏱️  Duration: ${duration}ms`);
    console.log(`   📈 Avg chunk time: ${chunkCount > 0 ? Math.round(duration / chunkCount) : 0}ms`);

    // Validate
    if (chunkCount === 0) {
      console.log(`   ⚠️  WARNING: No chunks received!`);
    }
    if (textContent.length === 0) {
      console.log(`   ⚠️  WARNING: No text content received!`);
    }

    console.log("─".repeat(60));
  } catch (error) {
    console.error(`\n❌ ERROR testing ${providerName}:`);
    if (error instanceof Error) {
      console.error(`   Message: ${error.message}`);
      console.error(`   Stack: ${error.stack}`);
    } else {
      console.error(`   ${String(error)}`);
    }
  }
}

/**
 * Main test runner
 */
async function runAllTests(): Promise<void> {
  console.log("\n🧪 LLM STREAMING TESTS (Using Stored Keys)");
  console.log("Loading API keys from Paprwork secure storage\n");

  // NOTE: This won't work without Electron runtime for safeStorage
  // We need to load keys from the stored JSON and decrypt them
  console.log("⚠️  Note: This test requires Electron runtime for key decryption");
  console.log("Instead, use environment variables:\n");
  console.log("  ANTHROPIC_API_KEY=sk-... npm run test:llm-streaming");
  console.log("  OPENAI_API_KEY=sk-... npm run test:llm-streaming");
  console.log("  GOOGLE_API_KEY=... npm run test:llm-streaming\n");
  
  process.exit(0);
}

// Run tests
runAllTests().catch((error) => {
  console.error("\n💥 FATAL ERROR:", error);
  process.exit(1);
});
