#!/usr/bin/env node
/**
 * Ad-hoc detailed message retrieval test.
 * Requires: PAPR_API_KEY, PAPR_TEST_CHAT_ID in .env.local or env
 */

import Papr from "@papr/memory";
import { requirePaprApiKey } from "../../scripts/lib/testEnv.mjs";

const apiKey = requirePaprApiKey();
const chatId = process.env.PAPR_TEST_CHAT_ID;

if (!chatId) {
  console.error("❌ PAPR_TEST_CHAT_ID required");
  process.exit(1);
}

const client = new Papr({ xAPIKey: apiKey });

const response = await client.messages.sessions.retrieveHistory(chatId, { limit: 100 });

console.log(`\nTotal in PAPR: ${response.total_count}`);
console.log(`Returned: ${response.messages.length}\n`);

console.log("=== ALL MESSAGES (newest first from PAPR) ===\n");
response.messages.forEach((m, i) => {
  const contentPreview =
    typeof m.content === "string"
      ? m.content.substring(0, 100)
      : `Array[${m.content?.length || 0}] - ${JSON.stringify(m.content[0] || {}).substring(0, 80)}`;
  console.log(`[${i}] ${m.role.padEnd(10)} | ${m.createdAt} | ${contentPreview}...`);
});

console.log("\n=== Taking FIRST 6 (newest) ===\n");
response.messages.slice(0, 6).forEach((m, i) => {
  console.log(`[${i}] ${m.role} | ${typeof m.content === "string" ? m.content.substring(0, 60) : "[structured]"}...`);
});
