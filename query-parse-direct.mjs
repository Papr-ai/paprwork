#!/usr/bin/env node
/**
 * Ad-hoc Parse Server query (internal debugging only).
 *
 * Requires in .env.local or env:
 *   PARSE_SERVER_URL
 *   PARSE_APPLICATION_ID
 *   PARSE_MASTER_KEY
 *   PAPR_TEST_CHAT_ID (session id)
 */

import fetch from "node-fetch";
import { requireEnv } from "./scripts/lib/testEnv.mjs";

const PARSE_SERVER_URL = requireEnv("PARSE_SERVER_URL");
const PARSE_APPLICATION_ID = requireEnv("PARSE_APPLICATION_ID");
const PARSE_MASTER_KEY = requireEnv("PARSE_MASTER_KEY");
const sessionId = process.env.PAPR_TEST_CHAT_ID;

if (!sessionId) {
  console.error("❌ PAPR_TEST_CHAT_ID required");
  process.exit(1);
}

const chatQuery = JSON.stringify({ sessionId });
const chatResponse = await fetch(
  `${PARSE_SERVER_URL}/parse/classes/Chat?where=${encodeURIComponent(chatQuery)}&limit=1`,
  {
    headers: {
      "X-Parse-Application-Id": PARSE_APPLICATION_ID,
      "X-Parse-Master-Key": PARSE_MASTER_KEY,
      "Content-Type": "application/json",
    },
  },
);

const chatData = await chatResponse.json();
if (!chatData.results?.length) {
  console.error("Chat not found");
  process.exit(1);
}

const chat = chatData.results[0];
console.log("Chat found:", chat.objectId, "messageCount:", chat.messageCount);

const messageQuery = JSON.stringify({
  chat: { __type: "Pointer", className: "Chat", objectId: chat.objectId },
});

const messagesResponse = await fetch(
  `${PARSE_SERVER_URL}/parse/classes/PostMessage?where=${encodeURIComponent(messageQuery)}&order=-createdAt&limit=100`,
  {
    headers: {
      "X-Parse-Application-Id": PARSE_APPLICATION_ID,
      "X-Parse-Master-Key": PARSE_MASTER_KEY,
      "Content-Type": "application/json",
    },
  },
);

const messagesData = await messagesResponse.json();
console.log(`\nTotal messages in Parse: ${messagesData.results.length}`);

const roleCount = messagesData.results.reduce((acc, m) => {
  acc[m.messageRole] = (acc[m.messageRole] || 0) + 1;
  return acc;
}, {});

console.log("Role distribution:", roleCount);

console.log("\nAll messages (newest first):");
messagesData.results.forEach((m, i) => {
  const userPointer = m.user?.objectId?.substring(0, 8) || "unknown";
  console.log(
    `  [${i}] ${m.messageRole.padEnd(10)} user=${userPointer} ${m.createdAt} - "${m.message?.substring(0, 50) || ""}"`,
  );
});
