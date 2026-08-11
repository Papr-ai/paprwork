#!/usr/bin/env node
/**
 * Ad-hoc Papr assistant message test.
 * Requires: PAPR_API_KEY, PAPR_TEST_CHAT_ID in .env.local or env
 */

import Papr from "@papr/memory";
import { requirePaprApiKey } from "../../scripts/lib/testEnv.mjs";

const PAPR_API_KEY = requirePaprApiKey();
const chatId = process.env.PAPR_TEST_CHAT_ID;

if (!chatId) {
  console.error("❌ PAPR_TEST_CHAT_ID required");
  process.exit(1);
}

const client = new Papr({ xAPIKey: PAPR_API_KEY });

console.log("\n📊 Fetching messages from PAPR...\n");

try {
  const response = await client.messages.sessions.retrieveHistory(chatId, {
    limit: 100,
  });

  console.log(`Total: ${response.total_count}, Returned: ${response.messages.length}\n`);

  response.messages.forEach((m, i) => {
    const preview =
      typeof m.content === "string"
        ? m.content.substring(0, 100)
        : JSON.stringify(m.content).substring(0, 100);
    console.log(`[${i}] ${m.role.padEnd(10)} | ${preview}...`);
  });
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}
