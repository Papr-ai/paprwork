#!/usr/bin/env node
/**
 * One-shot gateway stream latency profile (no UI).
 *
 * Usage:
 *   PAPR_STREAM_PROFILE=1 npm run profile:stream
 *   PAPR_STREAM_PROFILE=1 npm run profile:stream -- --chat-id=<uuid> --message="Hi"
 *
 * Requires OPENAI_API_KEY (or another provider via --provider/--model) in .env.local.
 */

import { config } from "dotenv";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";

config({ path: ".env.local" });

process.env.PAPR_STREAM_PROFILE = process.env.PAPR_STREAM_PROFILE ?? "1";

const args = process.argv.slice(2);
const chatIdArg = args.find((a) => a.startsWith("--chat-id="))?.split("=")[1];
const messageArg = args.find((a) => a.startsWith("--message="))?.slice("--message=".length);
const providerArg = args.find((a) => a.startsWith("--provider="))?.split("=")[1] ?? "openai";
const modelArg = args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? "gpt-4o-mini";

const userMessage = messageArg ?? "Reply with exactly: OK";

async function main() {
  const { AgentService } = await import("../dist/gateway/services/AgentService.js");
  const { startStreamProfiler, finishStreamProfiler } = await import(
    "../dist/core/utils/streamProfiler.js"
  );

  const testDir = path.join(os.tmpdir(), `paprwork-stream-profile-${Date.now()}`);
  await fs.mkdir(testDir, { recursive: true });

  const apiKeyEnv =
    providerArg === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : providerArg === "google"
        ? "GOOGLE_GENERATIVE_AI_API_KEY"
        : "OPENAI_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    console.error(`Missing ${apiKeyEnv} in .env.local`);
    process.exit(1);
  }

  const agentService = new AgentService();
  await agentService.initialize({
    mode: "local",
    userDataPath: testDir,
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  });

  const chatId = chatIdArg ?? randomUUID();
  if (!chatIdArg) {
    await agentService.createChat(chatId, "Stream Profile");
  }

  startStreamProfiler(chatId, "gateway-script");

  const configInternal = {
    provider: providerArg,
    model: modelArg,
    apiKey,
  };

  console.log(`\nProfiling stream: chat=${chatId} provider=${providerArg} model=${modelArg}`);
  console.log(`Message: "${userMessage}"\n`);

  const t0 = performance.now();
  let chunkCount = 0;
  let firstChunkMs = null;
  let firstTextMs = null;

  try {
    for await (const chunk of agentService.streamAgent(
      chatId,
      userMessage,
      configInternal,
    )) {
      chunkCount++;
      const elapsed = performance.now() - t0;
      if (firstChunkMs === null) {
        firstChunkMs = elapsed;
        console.log(`  first chunk @ ${elapsed.toFixed(1)}ms type=${chunk.type}`);
      }
      if (chunk.type === "text-delta" && firstTextMs === null) {
        firstTextMs = elapsed;
        console.log(`  first text-delta @ ${elapsed.toFixed(1)}ms`);
      }
      if (chunk.type === "stream-start") {
        console.log(`  stream-start @ ${elapsed.toFixed(1)}ms`);
      }
    }
  } finally {
    finishStreamProfiler(chatId, { provider: providerArg, model: modelArg });
    await agentService.shutdown();
    await fs.rm(testDir, { recursive: true, force: true });
  }

  console.log(`\nChunks: ${chunkCount}, wall time: ${(performance.now() - t0).toFixed(1)}ms`);
  if (firstTextMs !== null && firstChunkMs !== null && firstTextMs > firstChunkMs) {
    console.log(
      `Gap stream-start → first text: ${(firstTextMs - firstChunkMs).toFixed(1)}ms (model + gateway buffer)`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
