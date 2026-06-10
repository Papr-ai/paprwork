/**
 * AI Proxy Integration Test
 * 
 * Tests the Papr AI proxy (memory.papr.ai/v1/ai/{provider}/...) using
 * the exact same Vercel AI SDK that paprwork-v2 uses in production.
 * 
 * This mirrors the createLanguageModel() flow in AgentService.ts
 * but points at the Papr proxy instead of direct provider APIs.
 * 
 * Usage:
 *   npx tsx tests/ai-proxy-integration.ts
 */

import { streamText, generateText, tool } from "ai";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

// ── Config ──────────────────────────────────────────────────
const PROXY_BASE = process.env.PROXY_BASE ?? "https://memoryserver-development-223473570766.us-west1.run.app/v1/ai";
const PAPR_KEY = process.env.PAPR_API_KEY ?? "sk-org-wVPc17GuOO-namespace-sZCTT5QCea-6bTRICQOueQr5TsJ20loOikwR8io1rYn";

// ── Provider setup (mirrors AgentService.createLanguageModel) ──

// OpenAI: SDK sends `Authorization: Bearer {apiKey}` → proxy needs X-API-Key
// So we pass apiKey as dummy and add X-API-Key in headers
const openai = createOpenAI({
  baseURL: `${PROXY_BASE}/openai`,
  apiKey: "papr-proxy",  // SDK requires non-empty, but proxy ignores this
  headers: { "X-API-Key": PAPR_KEY },
});

// Anthropic: SDK sends `x-api-key: {apiKey}` → matches our proxy's X-API-Key!
// So we can just pass the papr key directly as apiKey
const anthropic = createAnthropic({
  baseURL: `${PROXY_BASE}/anthropic`,
  apiKey: PAPR_KEY,  // SDK sends as x-api-key which our proxy reads
});

// Google: SDK sends `x-goog-api-key: {apiKey}` → doesn't match X-API-Key
// So we need explicit headers like OpenAI
const google = createGoogleGenerativeAI({
  baseURL: `${PROXY_BASE}/google`,
  apiKey: "papr-proxy",
  headers: { "X-API-Key": PAPR_KEY },
});

// ── Test infrastructure ─────────────────────────────────────
interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: string;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<string>) {
  const start = Date.now();
  try {
    const details = await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration, details });
    console.log(`  ✅ ${name} (${duration}ms) — ${details}`);
  } catch (err: any) {
    const duration = Date.now() - start;
    const error = err?.message || String(err);
    results.push({ name, passed: false, duration, error });
    console.log(`  ❌ ${name} (${duration}ms) — ${error}`);
  }
}

// ── Tests ───────────────────────────────────────────────────

async function main() {
  console.log(`\n🔬 AI Proxy Integration Tests`);
  console.log(`   Proxy: ${PROXY_BASE}`);
  console.log(`   Key:   ${PAPR_KEY.slice(0, 12)}...${PAPR_KEY.slice(-4)}\n`);

  // ── OpenAI Tests ──────────────────────────────────────────

  console.log("── OpenAI ──");

  // GPT-5.4 uses responses API (same as AgentService)
  await runTest("OpenAI gpt-5.4 (responses, non-stream)", async () => {
    const result = await generateText({
      model: openai.responses("gpt-5.4"),
      prompt: "Say 'proxy works' and nothing else.",
      maxOutputTokens: 20,
    });
    if (!result.text) throw new Error("Empty response");
    return `"${result.text.slice(0, 50)}"`;
  });

  await runTest("OpenAI gpt-5.4-mini (responses, non-stream)", async () => {
    const result = await generateText({
      model: openai.responses("gpt-5.4-mini"),
      prompt: "Say 'mini works' and nothing else.",
      maxOutputTokens: 20,
    });
    if (!result.text) throw new Error("Empty response");
    return `"${result.text.slice(0, 50)}"`;
  });

  await runTest("OpenAI gpt-5.4 (responses, streaming)", async () => {
    const result = streamText({
      model: openai.responses("gpt-5.4"),
      prompt: "Count from 1 to 5, one number per line.",
      maxOutputTokens: 50,
    });
    let text = "";
    let chunks = 0;
    for await (const chunk of result.textStream) {
      text += chunk;
      chunks++;
    }
    if (!text) throw new Error("Empty stream");
    return `${chunks} chunks, "${text.slice(0, 50)}"`;
  });

  await runTest("OpenAI gpt-5.4-mini (chat completions, non-stream)", async () => {
    // Non-gpt-5 models use chat completions in AgentService
    const result = await generateText({
      model: openai("gpt-5.4-mini"),
      prompt: "Say 'completions works' and nothing else.",
      maxOutputTokens: 20,
    });
    if (!result.text) throw new Error("Empty response");
    return `"${result.text.slice(0, 50)}"`;
  });

  await runTest("OpenAI gpt-5.4-mini (chat completions, streaming)", async () => {
    const result = streamText({
      model: openai("gpt-5.4-mini"),
      prompt: "Count from 1 to 3.",
      maxOutputTokens: 30,
    });
    let text = "";
    let chunks = 0;
    for await (const chunk of result.textStream) {
      text += chunk;
      chunks++;
    }
    if (!text) throw new Error("Empty stream");
    return `${chunks} chunks, "${text.slice(0, 50)}"`;
  });

  // ── Anthropic Tests ───────────────────────────────────────

  console.log("\n── Anthropic ──");

  await runTest("Anthropic claude-haiku-4-5 (non-stream)", async () => {
    const result = await generateText({
      model: anthropic("claude-haiku-4-5"),
      prompt: "Say 'anthropic proxy works' and nothing else.",
      maxOutputTokens: 20,
    });
    if (!result.text) throw new Error("Empty response");
    return `"${result.text.slice(0, 50)}"`;
  });

  await runTest("Anthropic claude-sonnet-4-6 (non-stream)", async () => {
    const result = await generateText({
      model: anthropic("claude-sonnet-4-6"),
      prompt: "Say 'sonnet works' and nothing else.",
      maxOutputTokens: 20,
    });
    if (!result.text) throw new Error("Empty response");
    return `"${result.text.slice(0, 50)}"`;
  });

  await runTest("Anthropic claude-haiku-4-5 (streaming)", async () => {
    const result = streamText({
      model: anthropic("claude-haiku-4-5"),
      prompt: "Count from 1 to 5.",
      maxOutputTokens: 50,
    });
    let text = "";
    let chunks = 0;
    for await (const chunk of result.textStream) {
      text += chunk;
      chunks++;
    }
    if (!text) throw new Error("Empty stream");
    return `${chunks} chunks, "${text.slice(0, 50)}"`;
  });

  // ── Google Tests ──────────────────────────────────────────

  console.log("\n── Google ──");

  await runTest("Google gemini-2.5-flash (non-stream)", async () => {
    const result = await generateText({
      model: google("gemini-2.5-flash"),
      prompt: "Say 'gemini proxy works' and nothing else.",
      maxOutputTokens: 20,
    });
    if (!result.text) throw new Error("Empty response");
    return `"${result.text.slice(0, 50)}"`;
  });

  await runTest("Google gemini-2.5-flash (streaming)", async () => {
    const result = streamText({
      model: google("gemini-2.5-flash"),
      prompt: "Count from 1 to 3.",
      maxOutputTokens: 30,
    });
    let text = "";
    let chunks = 0;
    for await (const chunk of result.textStream) {
      text += chunk;
      chunks++;
    }
    if (!text) throw new Error("Empty stream");
    return `${chunks} chunks, "${text.slice(0, 50)}"`;
  });

  await runTest("Google gemini-3.5-flash (non-stream)", async () => {
    const result = await generateText({
      model: google("gemini-3.5-flash"),
      prompt: "Say 'gemini 3.5 works' and nothing else.",
      maxOutputTokens: 20,
    });
    if (!result.text) throw new Error("Empty response");
    return `"${result.text.slice(0, 50)}"`;
  });

  // ── Tool Calls ────────────────────────────────────────────

  console.log("\n── Tool Calls ──");

  await runTest("OpenAI gpt-5.4-mini with tool call", async () => {
    const result = await generateText({
      model: openai.responses("gpt-5.4-mini"),
      prompt: "What's the weather in San Francisco?",
      maxOutputTokens: 100,
      tools: {
        getWeather: tool({
          description: "Get the current weather for a location",
          inputSchema: z.object({
            location: z.string().describe("City name"),
          }),
        }),
      },
    });
    const toolCalls = result.toolCalls || [];
    if (toolCalls.length === 0) throw new Error("No tool calls made");
    return `Tool called: ${toolCalls[0].toolName}(${JSON.stringify((toolCalls[0] as any).args)})`;
  });

  await runTest("Anthropic claude-haiku-4-5 with tool call", async () => {
    const result = await generateText({
      model: anthropic("claude-haiku-4-5"),
      prompt: "What's the weather in Tokyo?",
      maxOutputTokens: 100,
      tools: {
        getWeather: tool({
          description: "Get the current weather for a location",
          inputSchema: z.object({
            location: z.string().describe("City name"),
          }),
        }),
      },
    });
    const toolCalls = result.toolCalls || [];
    if (toolCalls.length === 0) throw new Error("No tool calls made");
    return `Tool called: ${toolCalls[0].toolName}(${JSON.stringify((toolCalls[0] as any).args)})`;
  });

  // ── Summary ───────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════");
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n  ${passed} passed, ${failed} failed out of ${results.length} tests\n`);

  if (failed > 0) {
    console.log("  Failed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`    ❌ ${r.name}: ${r.error}`);
    }
    console.log();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
