#!/usr/bin/env node
/**
 * Ad-hoc Papr SDK limit test.
 * Requires: PAPR_API_KEY, PAPR_TEST_CHAT_ID in .env.local or env
 */

import Papr from "@papr/memory";
import { requirePaprApiKey } from "../../scripts/lib/testEnv.mjs";

const chatId = process.env.PAPR_TEST_CHAT_ID;
const apiKey = requirePaprApiKey();

if (!chatId) {
  console.error("❌ PAPR_TEST_CHAT_ID required");
  process.exit(1);
}

const client = new Papr({
  xAPIKey: apiKey,
  maxRetries: 3,
  timeout: 30000,
});

console.log("\n" + "=".repeat(80));
console.log("Testing Papr SDK with limit=100 (what Paprwork uses)");
console.log("=".repeat(80) + "\n");

for (const limit of [10, 50, 100]) {
  console.log(`\nLimit=${limit}:`);
  const response = await client.messages.sessions.retrieveHistory(chatId, { limit });

  const roleCount = response.messages.reduce((acc, m) => {
    acc[m.role] = (acc[m.role] || 0) + 1;
    return acc;
  }, {});

  console.log(`  Retrieved: ${response.messages.length}/${response.total_count}`);
  console.log(`  Roles:`, roleCount);
}
