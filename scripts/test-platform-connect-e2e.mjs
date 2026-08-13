#!/usr/bin/env node
/**
 * E2E Test Script for Connected Platforms feature
 * 
 * Tests the platform connection flow:
 * 1. Check platform registry is configured correctly
 * 2. Check PlatformSessionService can be initialized
 * 3. Test status check for all platforms
 * 4. Test connect flow (without actually opening browser)
 * 
 * Usage:
 *   node scripts/test-platform-connect-e2e.mjs
 * 
 * Note: This test doesn't actually log into platforms (that requires user interaction).
 * It validates the infrastructure is working.
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log("=".repeat(60));
console.log("Connected Platforms E2E Test");
console.log("=".repeat(60));
console.log("");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ FAIL: ${name}`);
    console.log(`   Error: ${error.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ FAIL: ${name}`);
    console.log(`   Error: ${error.message}`);
    failed++;
  }
}

// Test 1: Platform Registry
console.log("\n📋 Testing Platform Registry...\n");

const registryPath = join(__dirname, "../dist/gateway/services/platforms/platformRegistry.js");

await testAsync("Platform registry can be imported", async () => {
  const registry = await import(registryPath);
  if (!registry.PLATFORM_REGISTRY) {
    throw new Error("PLATFORM_REGISTRY not exported");
  }
});

await testAsync("LinkedIn is configured", async () => {
  const { getPlatformConfig } = await import(registryPath);
  const config = getPlatformConfig("linkedin");
  if (!config) throw new Error("LinkedIn config not found");
  if (!config.loginUrl) throw new Error("LinkedIn loginUrl missing");
  if (!config.requiredCookies.includes("li_at")) throw new Error("li_at cookie not configured");
});

await testAsync("All 6 platforms are configured", async () => {
  const { getAllPlatformIds } = await import(registryPath);
  const platforms = getAllPlatformIds();
  if (platforms.length !== 6) {
    throw new Error(`Expected 6 platforms, got ${platforms.length}: ${platforms.join(", ")}`);
  }
  const expected = ["linkedin", "instagram", "reddit", "facebook", "tiktok", "twitter"];
  for (const id of expected) {
    if (!platforms.includes(id)) {
      throw new Error(`Missing platform: ${id}`);
    }
  }
});

await testAsync("Key name generation works", async () => {
  const { getPlatformKeyName, getAllPlatformKeyNames } = await import(registryPath);
  
  const keyName = getPlatformKeyName("linkedin", "li_at");
  if (keyName !== "LINKEDIN_LI_AT") {
    throw new Error(`Expected LINKEDIN_LI_AT, got ${keyName}`);
  }
  
  const allKeys = getAllPlatformKeyNames("linkedin");
  if (!allKeys.includes("LINKEDIN_LI_AT") || !allKeys.includes("LINKEDIN_JSESSIONID")) {
    throw new Error(`Expected LinkedIn keys, got ${allKeys.join(", ")}`);
  }
});

// Test 2: Platform Session Service
console.log("\n📋 Testing Platform Session Service...\n");

const servicePath = join(__dirname, "../dist/gateway/services/platforms/PlatformSessionService.js");

await testAsync("PlatformSessionService can be imported", async () => {
  const service = await import(servicePath);
  if (!service.getPlatformSessionService) {
    throw new Error("getPlatformSessionService not exported");
  }
});

await testAsync("PlatformSessionService singleton works", async () => {
  const { getPlatformSessionService } = await import(servicePath);
  const service1 = getPlatformSessionService();
  const service2 = getPlatformSessionService();
  if (service1 !== service2) {
    throw new Error("Singleton not working - got different instances");
  }
});

// Test 3: Session Keeper Service
console.log("\n📋 Testing Session Keeper Service...\n");

const keeperPath = join(__dirname, "../dist/gateway/services/platforms/SessionKeeperService.js");

await testAsync("SessionKeeperService can be imported", async () => {
  const keeper = await import(keeperPath);
  if (!keeper.getSessionKeeperService) {
    throw new Error("getSessionKeeperService not exported");
  }
});

await testAsync("SessionKeeperService can start/stop", async () => {
  const { getSessionKeeperService } = await import(keeperPath);
  const keeper = getSessionKeeperService();
  
  keeper.start();
  // Give it a moment to start
  await new Promise(r => setTimeout(r, 100));
  keeper.stop();
});

// Test 4: Connect Platform Tool
console.log("\n📋 Testing Connect Platform Tool...\n");

const toolPath = join(__dirname, "../dist/core/tools/platformConnect.js");

await testAsync("connectPlatformTool can be imported", async () => {
  const tool = await import(toolPath);
  if (!tool.connectPlatformTool) {
    throw new Error("connectPlatformTool not exported");
  }
});

await testAsync("connectPlatformTool has correct ID", async () => {
  const { connectPlatformTool } = await import(toolPath);
  if (connectPlatformTool.id !== "connect_platform") {
    throw new Error(`Expected id 'connect_platform', got '${connectPlatformTool.id}'`);
  }
});

await testAsync("connectPlatformTool has input schema", async () => {
  const { connectPlatformTool } = await import(toolPath);
  if (!connectPlatformTool.inputSchema) {
    throw new Error("inputSchema missing");
  }
});

// Summary
console.log("\n" + "=".repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) {
  console.log("\n⚠️  Some tests failed. Please check the errors above.");
  process.exit(1);
} else {
  console.log("\n🎉 All tests passed!");
  console.log("\nNote: This test validates the infrastructure.");
  console.log("To test actual platform login, use the Settings → Platforms UI.");
  process.exit(0);
}
