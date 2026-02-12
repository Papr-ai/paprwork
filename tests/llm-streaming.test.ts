/**
 * LLM Streaming Tests
 * 
 * Tests streaming functionality for multiple LLM providers:
 * - Anthropic (Claude)
 * - OpenAI (GPT)
 * - Google (Gemini)
 * 
 * Run with: npm run test:llm-streaming
 * 
 * Add your API keys to .env.local in the project root
 */

import { config } from "dotenv";
import { MastraAgent } from "../src/core/agents/MastraAgent.js";

// Load environment variables from .env.local
config({ path: ".env.local" });
import type { AgentConfig } from "../src/core/types/agents.js";
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
    envKey: "ANTHROPIC_API_KEY",
  },
  openai: {
    model: "gpt-5.2",
    provider: "openai",
    envKey: "OPENAI_API_KEY",
  },
  google: {
    model: "gemini-2.5-flash",
    provider: "google",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
};

/**
 * Test streaming for a specific provider
 */
async function testProviderStreaming(
  providerName: string,
  modelConfig: { model: string; provider: string; envKey: string },
): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing ${providerName.toUpperCase()} (${modelConfig.model})`);
  console.log("=".repeat(60));

  // Check if API key is available
  const apiKey = process.env[modelConfig.envKey];
  if (!apiKey) {
    console.log(`❌ SKIPPED: ${modelConfig.envKey} not set`);
    return;
  }

  try {
    // Create agent
    const agent = new MastraAgent(TEST_USER_DATA);
    await agent.initialize();

    // Create config
    const config: AgentConfig = {
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

      // Debug: Log raw chunk structure
      if (chunkCount <= 3) {
        console.log(`\n🔍 Chunk #${chunkCount}:`, JSON.stringify(chunk, null, 2));
      }

      switch (chunk.type) {
        case "text-delta":
          if (chunk.payload && typeof chunk.payload === "object") {
            const text = (chunk.payload as { text?: string }).text || "";
            textContent += text;
            process.stdout.write(text);
          }
          break;

        case "thinking-delta":
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
  console.log("\n🧪 LLM STREAMING TESTS");
  console.log("Testing multiple providers to verify streaming works correctly\n");

  // Check which API keys are available
  const availableProviders = Object.entries(TEST_MODELS).filter(
    ([_, config]) => !!process.env[config.envKey],
  );

  if (availableProviders.length === 0) {
    console.error("❌ ERROR: No API keys found!");
    console.error("Set at least one of:");
    Object.values(TEST_MODELS).forEach((config) => {
      console.error(`   - ${config.envKey}`);
    });
    process.exit(1);
  }

  console.log(`Found ${availableProviders.length} API key(s):`);
  availableProviders.forEach(([name, config]) => {
    console.log(`   ✓ ${name} (${config.envKey})`);
  });

  // Run tests sequentially
  for (const [providerName, modelConfig] of Object.entries(TEST_MODELS)) {
    await testProviderStreaming(providerName, modelConfig);
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("🎉 ALL TESTS COMPLETED");
  console.log("=".repeat(60));
}

// Run tests
runAllTests().catch((error) => {
  console.error("\n💥 FATAL ERROR:", error);
  process.exit(1);
});
