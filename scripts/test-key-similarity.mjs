#!/usr/bin/env tsx

/**
 * Test script for key similarity matching
 * Tests various scenarios to ensure fuzzy matching works correctly
 */

import {
  findSimilarKeys,
  isOptionalLLMKey,
} from "../src/core/utils/keySimilarity";

console.log("🧪 Testing Key Similarity Matching\n");

// Test 1: Same service name
console.log("Test 1: Same Service Name");
const test1 = findSimilarKeys("VERCEL_API_KEY", ["VERCEL_KEY", "STRIPE_KEY"], 0.6);
console.log("  Requested: VERCEL_API_KEY");
console.log("  Existing: VERCEL_KEY, STRIPE_KEY");
console.log("  Result:", test1);
console.log("  ✅ Expected: VERCEL_KEY with ~90% score\n");

// Test 2: Normalized match
console.log("Test 2: Normalized Match");
const test2 = findSimilarKeys("VERCEL_API_KEY", ["VERCEL_APIKEY"], 0.6);
console.log("  Requested: VERCEL_API_KEY");
console.log("  Existing: VERCEL_APIKEY");
console.log("  Result:", test2);
console.log("  ✅ Expected: VERCEL_APIKEY with ~95% score\n");

// Test 3: Substring match
console.log("Test 3: Substring Match");
const test3 = findSimilarKeys("NEON_DB_URL", ["NEON_DATABASE_URL"], 0.6);
console.log("  Requested: NEON_DB_URL");
console.log("  Existing: NEON_DATABASE_URL");
console.log("  Result:", test3);
console.log("  ✅ Expected: NEON_DATABASE_URL with ~80% score\n");

// Test 4: No similar keys
console.log("Test 4: No Similar Keys");
const test4 = findSimilarKeys("VERCEL_API_KEY", ["STRIPE_KEY", "OPENAI_KEY"], 0.6);
console.log("  Requested: VERCEL_API_KEY");
console.log("  Existing: STRIPE_KEY, OPENAI_KEY");
console.log("  Result:", test4);
console.log("  ✅ Expected: Empty array\n");

// Test 5: Multiple similar keys sorted by score
console.log("Test 5: Multiple Similar Keys");
const test5 = findSimilarKeys("VERCEL_API_KEY", [
  "VERCEL_KEY",
  "VERCEL_TOKEN",
  "VERCEL_SECRET",
  "STRIPE_KEY",
], 0.6);
console.log("  Requested: VERCEL_API_KEY");
console.log("  Existing: VERCEL_KEY, VERCEL_TOKEN, VERCEL_SECRET, STRIPE_KEY");
console.log("  Result:", test5);
console.log("  ✅ Expected: All VERCEL keys with high scores, sorted\n");

// Test 6: LLM provider key detection
console.log("Test 6: LLM Provider Key Detection");
const llmKeys = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_AI_API_KEY",
  "GOOGLE_GEMINI_API_KEY",
  "VERCEL_API_KEY",
];
console.log("  Testing keys:", llmKeys);
llmKeys.forEach((key) => {
  const isLLM = isOptionalLLMKey(key);
  console.log(`    ${key}: ${isLLM ? "✅ LLM Provider" : "❌ Not LLM"}`);
});
console.log();

// Test 7: Case insensitive matching
console.log("Test 7: Case Insensitive");
const test7 = findSimilarKeys("vercel_api_key", ["VERCEL_KEY"], 0.6);
console.log("  Requested: vercel_api_key (lowercase)");
console.log("  Existing: VERCEL_KEY (uppercase)");
console.log("  Result:", test7);
console.log("  ✅ Expected: VERCEL_KEY with high score\n");

// Test 8: Exact match (should return 100%)
console.log("Test 8: Exact Match");
const test8 = findSimilarKeys("VERCEL_API_KEY", ["VERCEL_API_KEY"], 0.6);
console.log("  Requested: VERCEL_API_KEY");
console.log("  Existing: VERCEL_API_KEY");
console.log("  Result:", test8);
console.log("  ✅ Expected: Exact match with 100% score\n");

console.log("✅ All tests completed!");
