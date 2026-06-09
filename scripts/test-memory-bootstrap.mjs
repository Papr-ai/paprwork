#!/usr/bin/env node
/**
 * Manual integration test for chat-start memory bootstrap.
 * Run: node --import tsx scripts/test-memory-bootstrap.mjs
 */
import {
  formatSyncTiersBlock,
  formatMessageSearchBlock,
  shouldBootstrapUserMemory,
  getUserMemoryContextService,
  IDLE_THRESHOLD_MS,
} from "../src/gateway/services/UserMemoryContextService.ts";
import { getPaprUserId } from "../src/gateway/utils/paprUserId.ts";

const userId = getPaprUserId();
console.log("Papr user_id:", userId ?? "(not configured)");

console.log("\n--- shouldBootstrapUserMemory ---");
console.log("empty history:", shouldBootstrapUserMemory([]));
console.log(
  "active chat:",
  shouldBootstrapUserMemory([
    {
      role: "user",
      content: "hi",
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      role: "assistant",
      content: "hello",
      timestamp: new Date(Date.now() - 30_000).toISOString(),
    },
    {
      role: "user",
      content: "follow up",
      timestamp: new Date().toISOString(),
    },
  ]),
);
console.log(
  "idle reopen:",
  shouldBootstrapUserMemory([
    {
      role: "user",
      content: "old",
      timestamp: new Date(Date.now() - IDLE_THRESHOLD_MS - 5000).toISOString(),
    },
    {
      role: "assistant",
      content: "old reply",
      timestamp: new Date(Date.now() - IDLE_THRESHOLD_MS - 4000).toISOString(),
    },
    {
      role: "user",
      content: "back",
      timestamp: new Date().toISOString(),
    },
  ]),
);

if (!userId) {
  console.log("\nSkipping live API test — no papr user_id in settings/env");
  process.exit(0);
}

const testMessage = process.argv[2] ?? "What are my current goals and projects?";
console.log(`\n--- Live bootstrap for: "${testMessage}" ---`);

const blocks = await getUserMemoryContextService().getMemoryContextBlocks(
  "test-chat-id",
  testMessage,
  [{ role: "user", content: testMessage, timestamp: new Date().toISOString() }],
);

console.log(`\nGot ${blocks.length} block(s):\n`);
for (const block of blocks) {
  console.log("---");
  console.log(block.substring(0, 800));
  if (block.length > 800) console.log("...[truncated for display]");
}

process.exit(blocks.length > 0 ? 0 : 1);
