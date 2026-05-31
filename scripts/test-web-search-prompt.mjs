#!/usr/bin/env node

/**
 * Test Web Search System Prompt Integration
 * 
 * Verifies that the system prompt correctly includes or excludes web search
 * documentation based on the provider.
 */

import { buildSystemPrompt } from "../dist/core/agents/SystemPrompt.js";

async function testWebSearchPrompt() {
  console.log("🔍 Testing Web Search System Prompt Integration\n");
  console.log("=".repeat(60));

  // Test 1: OpenAI (should have web search docs)
  console.log("\n1. Testing OpenAI provider...");
  const openaiPrompt = buildSystemPrompt({
    userDataPath: "~/.paprwork-v2",
    workspacePath: process.cwd(),
    availableTools: ["bash", "read_file"],
    customKeys: [],
    provider: "openai",
  });
  
  if (openaiPrompt.includes("# Web Search Tool (OpenAI)")) {
    console.log("   ✅ OpenAI web search documentation found");
  } else {
    console.log("   ❌ OpenAI web search documentation NOT found");
  }
  
  if (openaiPrompt.includes("web_search") && openaiPrompt.includes("native")) {
    console.log("   ✅ Native web_search tool mentioned");
  } else {
    console.log("   ❌ Native web_search tool NOT mentioned");
  }
  
  if (!openaiPrompt.includes("curl -s \"https://api.duckduckgo.com")) {
    console.log("   ✅ Curl web search example correctly excluded");
  } else {
    console.log("   ⚠️  Curl web search example still present (should be excluded)");
  }

  // Test 2: Google (should have web search docs)
  console.log("\n2. Testing Google provider...");
  const googlePrompt = buildSystemPrompt({
    userDataPath: "~/.paprwork-v2",
    workspacePath: process.cwd(),
    availableTools: ["bash", "read_file"],
    customKeys: [],
    provider: "google",
  });
  
  if (googlePrompt.includes("# Web Search Tool (Google)")) {
    console.log("   ✅ Google web search documentation found");
  } else {
    console.log("   ❌ Google web search documentation NOT found");
  }
  
  if (googlePrompt.includes("google_search")) {
    console.log("   ✅ Native google_search tool mentioned");
  } else {
    console.log("   ❌ Native google_search tool NOT mentioned");
  }

  // Test 3: Anthropic (should NOT have web search docs)
  console.log("\n3. Testing Anthropic provider...");
  const anthropicPrompt = buildSystemPrompt({
    userDataPath: "~/.paprwork-v2",
    workspacePath: process.cwd(),
    availableTools: ["bash", "read_file"],
    customKeys: [],
    provider: "anthropic",
  });
  
  if (!anthropicPrompt.includes("# Web Search Tool")) {
    console.log("   ✅ Web search documentation correctly excluded");
  } else {
    console.log("   ❌ Web search documentation found (should be excluded)");
  }
  
  if (anthropicPrompt.includes("curl -s \"https://api.duckduckgo.com")) {
    console.log("   ✅ Curl web search example available (correct for Anthropic)");
  } else {
    console.log("   ⚠️  Curl web search example not found");
  }

  // Test 4: No provider (backward compatibility)
  console.log("\n4. Testing no provider (backward compatibility)...");
  const noProviderPrompt = buildSystemPrompt({
    userDataPath: "~/.paprwork-v2",
    workspacePath: process.cwd(),
    availableTools: ["bash", "read_file"],
    customKeys: [],
  });
  
  if (!noProviderPrompt.includes("# Web Search Tool")) {
    console.log("   ✅ No web search documentation (correct)");
  } else {
    console.log("   ❌ Web search documentation found");
  }

  console.log("\n" + "=".repeat(60));
  console.log("\n✅ Testing complete!");
  console.log("\nNow test with a real agent:");
  console.log("1. npm start");
  console.log("2. Select OpenAI/GPT model");
  console.log("3. Ask: 'What's the latest news about AI?'");
  console.log("4. Verify agent uses web_search tool instead of curl\n");
}

testWebSearchPrompt().catch(console.error);
