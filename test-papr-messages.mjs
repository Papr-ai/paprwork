#!/usr/bin/env node
/**
 * Ad-hoc Papr message retrieval test.
 * Requires: PAPR_API_KEY in .env.local or env
 * Optional: PAPR_TEST_CHAT_ID (default below is a placeholder — set your own)
 */

import Papr from "@papr/memory";
import { requirePaprApiKey } from "./scripts/lib/testEnv.mjs";

const chatId = process.env.PAPR_TEST_CHAT_ID ?? "your-chat-id-here";
const apiKey = requirePaprApiKey();

if (chatId === "your-chat-id-here") {
  console.error("❌ Set PAPR_TEST_CHAT_ID to a real chat/session id");
  process.exit(1);
}

console.log("✓ Using PAPR_API_KEY from environment");
console.log(`Chat ID: ${chatId}`);
console.log("");

const client = new Papr({
  xAPIKey: apiKey,
  maxRetries: 3,
  timeout: 30000,
});

try {
  console.log("Calling PAPR API: retrieveHistory()");
  console.log("─".repeat(80));

  const response = await client.messages.sessions.retrieveHistory(chatId);

  console.log(`✓ Retrieved ${response.messages?.length || 0} messages`);
  console.log(`  Total count: ${response.total_count}`);
  console.log(`  Has summary: ${!!response.summaries}`);
  console.log(`  Context for LLM: ${response.context_for_llm}`);
  console.log("");

  if (response.messages && response.messages.length > 0) {
    console.log("MESSAGE BREAKDOWN:");
    console.log("─".repeat(80));

    const roleCount = response.messages.reduce((acc, m) => {
      acc[m.role] = (acc[m.role] || 0) + 1;
      return acc;
    }, {});

    console.log("Role counts:", roleCount);
    console.log("");

    response.messages.slice(0, 10).forEach((m, i) => {
      const preview =
        typeof m.content === "string"
          ? m.content.substring(0, 80)
          : JSON.stringify(m.content).substring(0, 80);
      console.log(`[${i}] ${m.role} — ${preview}...`);
    });
  }
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}
