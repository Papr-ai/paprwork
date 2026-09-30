#!/usr/bin/env node
/**
 * Micro-benchmark: cost of one AI SDK "prepareStep" (estimate + compact gate + trim gate).
 *
 * Usage:
 *   npx tsx scripts/benchmark-prepare-step-context.mjs
 *   npx tsx scripts/benchmark-prepare-step-context.mjs --steps=80
 */

import { performance } from "node:perf_hooks";

async function main() {
  const stepsArg = Number(
    process.argv.find((a) => a.startsWith("--steps="))?.split("=")[1] ?? 50,
  );
  const payloadChars = Number(
    process.argv.find((a) => a.startsWith("--payload="))?.split("=")[1] ?? 2_000,
  );

  const {
    compactStaleToolResults,
    estimateMessagesTokens,
    DEFAULT_KEEP_LAST_BATCHES,
  } = await import("../src/gateway/services/agent/compactToolResults.js");
  const { trimOldestHistoryTurns, computeHistoryTrimBounds } = await import(
    "../src/gateway/services/agent/midTurnContextTrim.js"
  );
  const { shouldCompactMidTurn } = await import(
    "../src/gateway/services/agent/compactionPressure.js"
  );
  const { computeHistoryTokenBudget } = await import(
    "../src/gateway/services/agent/contextBudget.js"
  );

  const makeToolResult = (textLen, id) => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "bash",
        output: { type: "text", value: "x".repeat(textLen) },
      },
    ],
  });

  const makeAssistantToolCall = (id) => ({
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "bash",
        args: { command: "echo hi" },
      },
    ],
  });

  const buildConversation = (stepCount, resultChars) => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Do many tool steps." },
    ];
    for (let s = 0; s < stepCount; s += 1) {
      const id = `call_${s}`;
      messages.push(makeAssistantToolCall(id));
      messages.push(makeToolResult(resultChars, id));
    }
    return messages;
  };

  const median = (nums) => {
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const bench = (fn, iterations) => {
    fn();
    const samples = [];
    for (let i = 0; i < iterations; i += 1) {
      const t0 = performance.now();
      fn();
      samples.push(performance.now() - t0);
    }
    const sum = samples.reduce((a, b) => a + b, 0);
    samples.sort((a, b) => a - b);
    return {
      iterations,
      totalMs: sum,
      meanMs: sum / iterations,
      medianMs: median(samples),
      p95Ms: samples[Math.floor(samples.length * 0.95)] ?? samples.at(-1),
    };
  };

  const prepareStepCurrent = (messages, historyTokenBudget, historyTrimBounds) => {
    const msgs = [...messages];
    compactStaleToolResults(msgs, { historyTokenBudget });
    trimOldestHistoryTurns(msgs, {
      ...historyTrimBounds,
      maxTokens: historyTokenBudget,
    });
    return msgs;
  };

  const prepareStepOptimized = (
    messages,
    historyTokenBudget,
    historyTrimBounds,
    cumulativePromptTokens,
    toolTokens,
  ) => {
    const est =
      cumulativePromptTokens > 0
        ? cumulativePromptTokens
        : estimateMessagesTokens(messages) + toolTokens;
    const underTrim = est <= historyTokenBudget;
    const underCompact = !shouldCompactMidTurn({
      estimatedTokens: est,
      historyTokenBudget,
    });
    if (underTrim && underCompact) {
      return messages;
    }
    const msgs = [...messages];
    compactStaleToolResults(msgs, { historyTokenBudget });
    trimOldestHistoryTurns(msgs, {
      ...historyTrimBounds,
      maxTokens: historyTokenBudget,
    });
    return msgs;
  };

  const formatRow = (name, r) =>
    `${name.padEnd(28)} mean=${r.meanMs.toFixed(3)}ms  median=${r.medianMs.toFixed(3)}ms  p95=${r.p95Ms.toFixed(3)}ms  x${r.iterations} total=${r.totalMs.toFixed(1)}ms`;

  const toolTokens = 87_363;
  const historyTokenBudget = computeHistoryTokenBudget({
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    toolTokenEstimate: toolTokens,
    maxOutputTokens: 16_000,
    contextLimit: 200_000,
  });

  const smallResult = buildConversation(stepsArg, 2_000);
  const largeResult = buildConversation(stepsArg, 40_000);
  const boundsSmall = computeHistoryTrimBounds(smallResult);
  const boundsLarge = computeHistoryTrimBounds(largeResult);
  const tokensSmall = estimateMessagesTokens(smallResult);
  const tokensLarge = estimateMessagesTokens(largeResult);

  console.log("Prepare-step context micro-benchmark\n");
  console.log(`Simulated turn: ${stepsArg} tool steps, ${payloadChars} chars/result`);
  console.log(`keepLastBatches=${DEFAULT_KEEP_LAST_BATCHES}`);
  console.log(
    `2KB/tool: ~${Math.round(tokensSmall / 1000)}K est tokens, ${smallResult.length} messages`,
  );
  console.log(
    `40KB/tool: ~${Math.round(tokensLarge / 1000)}K est tokens, ${largeResult.length} messages`,
  );
  console.log(`historyTokenBudget: ~${Math.round(historyTokenBudget / 1000)}K\n`);

  console.log("Single prepareStep on final prompt:\n");
  console.log(formatRow("estimate only (2KB)", bench(() => estimateMessagesTokens(smallResult), 200)));
  console.log(formatRow("estimate only (40KB)", bench(() => estimateMessagesTokens(largeResult), 80)));
  console.log(
    formatRow(
      "current prepareStep (2KB)",
      bench(() => prepareStepCurrent(smallResult, historyTokenBudget, boundsSmall), 40),
    ),
  );
  console.log(
    formatRow(
      "optimized prepareStep (2KB)",
      bench(
        () =>
          prepareStepOptimized(
            smallResult,
            historyTokenBudget,
            boundsSmall,
            tokensSmall + toolTokens,
            toolTokens,
          ),
        40,
      ),
    ),
  );
  console.log(
    formatRow(
      "current prepareStep (40KB)",
      bench(() => prepareStepCurrent(largeResult, historyTokenBudget, boundsLarge), 20),
    ),
  );

  console.log("\nFull turn (prepareStep each step, 2KB results):\n");

  const simulateTurn = (useOptimized) => {
    let messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Do many tool steps." },
    ];
    let cumulativePromptTokens = 0;
    const perStepMs = [];
    for (let s = 0; s < stepsArg; s += 1) {
      const id = `call_${s}`;
      messages.push(makeAssistantToolCall(id));
      messages.push(makeToolResult(payloadChars, id));
      const bounds = computeHistoryTrimBounds(messages);
      const t0 = performance.now();
      if (useOptimized) {
        prepareStepOptimized(
          messages,
          historyTokenBudget,
          bounds,
          cumulativePromptTokens,
          toolTokens,
        );
      } else {
        prepareStepCurrent(messages, historyTokenBudget, bounds);
      }
      perStepMs.push(performance.now() - t0);
      cumulativePromptTokens = estimateMessagesTokens(messages) + toolTokens;
    }
    return perStepMs;
  };

  const currentPerStep = simulateTurn(false);
  const optimizedPerStep = simulateTurn(true);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const currentTotal = sum(currentPerStep);
  const optimizedTotal = sum(optimizedPerStep);

  console.log(
    `Current:  total=${currentTotal.toFixed(1)}ms  mean/step=${(currentTotal / stepsArg).toFixed(3)}ms`,
  );
  console.log(
    `Optimized: total=${optimizedTotal.toFixed(1)}ms  mean/step=${(optimizedTotal / stepsArg).toFixed(3)}ms`,
  );
  console.log(
    `Delta: ${(currentTotal - optimizedTotal).toFixed(1)}ms (${(((currentTotal - optimizedTotal) / currentTotal) * 100).toFixed(1)}%)\n`,
  );

  const tightBudget = Math.floor(tokensSmall * 0.5);
  console.log("Compaction under pressure (tight budget = 50% of final prompt):\n");
  console.log(
    formatRow(
      "compact gate under budget",
      bench(() => compactStaleToolResults([...smallResult], { historyTokenBudget }), 80),
    ),
  );
  console.log(
    formatRow(
      "compact tight budget",
      bench(() => compactStaleToolResults([...smallResult], { historyTokenBudget: tightBudget }), 20),
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
