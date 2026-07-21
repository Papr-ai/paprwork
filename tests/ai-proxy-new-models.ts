/**
 * Smoke test for Z.ai, Groq, and Moonshot Kimi models via Papr AI proxy.
 *
 * Usage:
 *   npx tsx tests/ai-proxy-new-models.ts
 *   PROXY_BASE=http://127.0.0.1:5002/v1/ai npx tsx tests/ai-proxy-new-models.ts
 */

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import {
  buildZaiProviderOptions,
  normalizeZaiModelId,
} from "../src/gateway/utils/zaiModel.js";
import { createMoonshotChatModel } from "../src/gateway/utils/moonshotProvider.js";

const PROXY_BASE =
  process.env.PROXY_BASE ??
  process.env.PAPR_AI_PROXY_BASE_URL ??
  "https://memory.papr.ai/v1/ai";
const PAPR_KEY = process.env.PAPR_API_KEY;

if (!PAPR_KEY) {
  console.error("Set PAPR_API_KEY (e.g. in .env.local) to run this test.");
  process.exit(1);
}

function makeProxy(path: "zai" | "groq") {
  return createOpenAI({
    baseURL: `${PROXY_BASE}/${path}`,
    apiKey: "papr-proxy",
    headers: { "X-API-Key": PAPR_KEY },
  });
}

async function makeMoonshotModel() {
  return createMoonshotChatModel("kimi-k3", {
    apiKey: "papr-proxy",
    baseURL: `${PROXY_BASE}/moonshot`,
    headers: { "X-API-Key": PAPR_KEY! },
  });
}

const zai = makeProxy("zai");
const groq = makeProxy("groq");

type Status = "pass" | "fail" | "skip";

interface Case {
  name: string;
  run: () => Promise<{ status: Status; detail: string }>;
}

const cases: Case[] = [
  {
    name: "Z.ai glm-5.2",
    run: async () => {
      const r = await generateText({
        model: zai.chat("glm-5.2"),
        prompt: "Reply with exactly: glm ok",
        maxOutputTokens: 80,
        providerOptions: {
          openai: {
            thinking: { type: "enabled" },
            reasoning_effort: "high",
          },
        },
      });
      if (!r.text?.trim()) {
        return { status: "fail", detail: "Empty response" };
      }
      return { status: "pass", detail: r.text.trim().slice(0, 80) };
    },
  },
  {
    name: "Z.ai glm-5.2-max",
    run: async () => {
      const r = await generateText({
        model: zai.chat(normalizeZaiModelId("glm-5.2-max")),
        prompt: "Reply with exactly: glm max ok",
        maxOutputTokens: 80,
        providerOptions: buildZaiProviderOptions("glm-5.2-max"),
      });
      if (!r.text?.trim()) {
        return { status: "fail", detail: "Empty response" };
      }
      return { status: "pass", detail: r.text.trim().slice(0, 80) };
    },
  },
  {
    name: "Groq qwen/qwen3-32b",
    run: async () => {
      const r = await generateText({
        model: groq.chat("qwen/qwen3-32b"),
        prompt: "Reply with exactly: qwen ok",
        maxOutputTokens: 80,
      });
      if (!r.text?.trim()) {
        return { status: "fail", detail: "Empty response" };
      }
      return { status: "pass", detail: r.text.trim().slice(0, 80) };
    },
  },
  {
    name: "Groq openai/gpt-oss-120b",
    run: async () => {
      const r = await generateText({
        model: groq.chat("openai/gpt-oss-120b"),
        prompt: "Reply with exactly: gpt-oss ok",
        maxOutputTokens: 100,
        providerOptions: { openai: { reasoning_effort: "medium" } },
      });
      if (!r.text?.trim()) {
        return { status: "fail", detail: "Empty response" };
      }
      return { status: "pass", detail: r.text.trim().slice(0, 80) };
    },
  },
  {
    name: "Moonshot kimi-k3",
    run: async () => {
      const model = await makeMoonshotModel();
      const r = await generateText({
        model,
        prompt: "Reply with exactly: kimi ok",
        maxOutputTokens: 100,
      });
      if (!r.text?.trim()) {
        return { status: "fail", detail: "Empty response" };
      }
      return { status: "pass", detail: r.text.trim().slice(0, 80) };
    },
  },
];

async function main() {
  console.log(`\nNew model proxy smoke tests`);
  console.log(`Proxy: ${PROXY_BASE}`);
  console.log(`Key:   ${PAPR_KEY.slice(0, 12)}...${PAPR_KEY.slice(-4)}\n`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const c of cases) {
    const start = Date.now();
    try {
      const { status, detail } = await c.run();
      const ms = Date.now() - start;
      if (status === "pass") {
        passed++;
        console.log(`  ✅ ${c.name} (${ms}ms) — ${detail}`);
      } else if (status === "skip") {
        skipped++;
        console.log(`  ⏭️  ${c.name} (${ms}ms) — ${detail}`);
      } else {
        failed++;
        console.log(`  ❌ ${c.name} (${ms}ms) — ${detail}`);
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      const ms = Date.now() - start;
      if (msg.includes("Unauthorized") || msg.includes("Authentication Failed")) {
        console.log(
          `  ❌ ${c.name} (${ms}ms) — ZAI_API_KEY invalid on memory server (401 from api.z.ai)`,
        );
      } else {
        console.log(`  ❌ ${c.name} (${ms}ms) — ${msg.slice(0, 200)}`);
      }
    }
  }

  console.log(
    `\n${passed} passed, ${failed} failed, ${skipped} skipped (${cases.length} total)\n`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
