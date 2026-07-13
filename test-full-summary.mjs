#!/usr/bin/env node
/**
 * Ad-hoc Papr summary test.
 * Requires: PAPR_API_KEY, PAPR_TEST_CHAT_ID in .env.local or env
 */

import Papr from "@papr/memory";
import { requirePaprApiKey } from "./scripts/lib/testEnv.mjs";

const apiKey = requirePaprApiKey();
const chatId = process.env.PAPR_TEST_CHAT_ID;

if (!chatId) {
  console.error("❌ PAPR_TEST_CHAT_ID required");
  process.exit(1);
}

const client = new Papr({ xAPIKey: apiKey });

const response = await client.messages.sessions.retrieveHistory(chatId, { limit: 100 });

console.log("\n=== FULL SUMMARY ===\n");
console.log("SHORT TERM (last 15 messages):");
console.log(response.summaries.short_term);
console.log("\n---\n");
console.log("MEDIUM TERM (last ~100 messages):");
console.log(response.summaries.medium_term);
console.log("\n---\n");
console.log("LONG TERM:");
console.log(response.summaries.long_term);
