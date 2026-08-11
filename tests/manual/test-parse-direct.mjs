#!/usr/bin/env node
/**
 * Ad-hoc Parse Server inspection (internal debugging only).
 *
 * Requires in .env.local or env:
 *   PAPR_API_KEY
 *   PARSE_MASTER_KEY
 *   PARSE_APPLICATION_ID
 *   PARSE_SERVER_URL (optional)
 *   PAPR_TEST_CHAT_ID (session id)
 */

import { requireEnv, requirePaprApiKey } from "../../scripts/lib/testEnv.mjs";

requirePaprApiKey();

const chatId = process.env.PAPR_TEST_CHAT_ID;
const parseServerUrl = process.env.PARSE_SERVER_URL ?? "https://api.papr.ai";
const parseAppId = requireEnv("PARSE_APPLICATION_ID");
const parseMasterKey = requireEnv("PARSE_MASTER_KEY");

if (!chatId) {
  console.error("❌ PAPR_TEST_CHAT_ID required");
  process.exit(1);
}

console.log("\n🔍 Checking assistant messages in Parse Server directly...\n");

const chatsResponse = await fetch(
  `${parseServerUrl}/parse/classes/Chat?where=${encodeURIComponent(JSON.stringify({ sessionId: chatId }))}&limit=1`,
  {
    headers: {
      "X-Parse-Application-Id": parseAppId,
      "X-Parse-Master-Key": parseMasterKey,
    },
  },
);

const chatsData = await chatsResponse.json();
if (!chatsData.results?.length) {
  console.error("Chat not found");
  process.exit(1);
}

const chat = chatsData.results[0];
console.log(`Chat objectId: ${chat.objectId}, messageCount: ${chat.messageCount}`);

const messageQuery = JSON.stringify({
  chat: { __type: "Pointer", className: "Chat", objectId: chat.objectId },
});

const messagesResponse = await fetch(
  `${parseServerUrl}/parse/classes/PostMessage?where=${encodeURIComponent(messageQuery)}&order=-createdAt&limit=100`,
  {
    headers: {
      "X-Parse-Application-Id": parseAppId,
      "X-Parse-Master-Key": parseMasterKey,
    },
  },
);

const messagesData = await messagesResponse.json();
console.log(`\nTotal messages: ${messagesData.results?.length ?? 0}`);

for (const [i, m] of (messagesData.results ?? []).entries()) {
  console.log(
    `[${i}] ${m.messageRole?.padEnd(10) ?? "?"} | ${m.createdAt} | ${String(m.message ?? "").substring(0, 80)}`,
  );
}
