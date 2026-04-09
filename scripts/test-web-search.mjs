#!/usr/bin/env node

/**
 * Web Search Integration Testing
 * 
 * This script helps verify that native web search tools are properly configured
 * for all supported providers (Claude, GPT, Gemini).
 * 
 * Usage:
 *   node scripts/test-web-search.mjs
 * 
 * What it tests:
 * 1. AI SDK provider imports
 * 2. Web search tool availability
 * 3. Tool configuration structure
 */

async function testWebSearchTools() {
  console.log("🔍 Testing Web Search Integration\n");
  console.log("=".repeat(60));

  // Test 1: Anthropic Web Search
  console.log("\n1. Testing Anthropic (Claude) Web Search...");
  try {
    const { anthropic } = await import("@ai-sdk/anthropic");
    
    if (anthropic.tools?.webSearch_20260209) {
      const tool = anthropic.tools.webSearch_20260209({ maxUses: 5 });
      console.log("   ✅ anthropic.tools.webSearch_20260209 available");
      console.log(`   Tool structure: ${JSON.stringify(Object.keys(tool)).substring(0, 100)}`);
    } else if (anthropic.tools?.webSearch_20250305) {
      const tool = anthropic.tools.webSearch_20250305({ maxUses: 5 });
      console.log("   ⚠️  anthropic.tools.webSearch_20250305 available (older version)");
      console.log(`   Tool structure: ${JSON.stringify(Object.keys(tool)).substring(0, 100)}`);
    } else {
      console.log("   ❌ No webSearch tool found in anthropic.tools");
    }
  } catch (error) {
    console.log(`   ❌ Failed: ${error.message}`);
  }

  // Test 2: OpenAI Web Search
  console.log("\n2. Testing OpenAI (GPT) Web Search...");
  try {
    const { openai } = await import("@ai-sdk/openai");
    
    if (openai.tools?.webSearch) {
      const tool = openai.tools.webSearch({ maxUses: 5 });
      console.log("   ✅ openai.tools.webSearch available");
      console.log(`   Tool structure: ${JSON.stringify(Object.keys(tool)).substring(0, 100)}`);
    } else {
      console.log("   ❌ No webSearch tool found in openai.tools");
    }
  } catch (error) {
    console.log(`   ❌ Failed: ${error.message}`);
  }

  // Test 3: Google Search Grounding
  console.log("\n3. Testing Google (Gemini) Search Grounding...");
  try {
    const { google } = await import("@ai-sdk/google");
    
    if (google.tools?.googleSearch) {
      const tool = google.tools.googleSearch({});
      console.log("   ✅ google.tools.googleSearch available");
      console.log(`   Tool structure: ${JSON.stringify(Object.keys(tool)).substring(0, 100)}`);
    } else {
      console.log("   ❌ No googleSearch tool found in google.tools");
    }
  } catch (error) {
    console.log(`   ❌ Failed: ${error.message}`);
  }

  // Test 4: pi-ai Native Tool Support
  console.log("\n4. Testing pi-ai Native Tool Support...");
  try {
    const piAi = await import("@mariozechner/pi-ai");
    console.log(`   ✅ @mariozechner/pi-ai version: ${piAi.version || 'unknown'}`);
    
    // Check if Context interface supports native tools
    console.log("   ℹ️  Native tools must be passed in tools array with custom tools");
    console.log("   ℹ️  Format: { type: 'web_search_20260209', name: 'web_search', max_uses: 10 }");
  } catch (error) {
    console.log(`   ❌ Failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("\n✅ Testing complete!");
  console.log("\nTo test web search in action:");
  console.log("1. Start the app: npm start");
  console.log("2. Select a model (Claude, GPT, or Gemini)");
  console.log("3. Ask: 'What's the latest news about AI?'");
  console.log("4. Wait for model to search");
  console.log("5. Verify response includes citations\n");
}

testWebSearchTools().catch(console.error);
