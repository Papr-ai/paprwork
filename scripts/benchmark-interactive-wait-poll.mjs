#!/usr/bin/env node
/**
 * Cost of waitForInteractiveQuietBeforeBackgroundWork polling (not the background work itself).
 *
 * Usage:
 *   node --import tsx scripts/benchmark-interactive-wait-poll.mjs
 */

import { performance } from "node:perf_hooks";

async function main() {
  const {
    enterInteractiveHotPath,
    leaveInteractiveHotPath,
    waitForInteractiveQuietBeforeBackgroundWork,
  } = await import("../src/gateway/services/gatewayInteractivePriority.js");

  enterInteractiveHotPath("agent:stream");

  const t0 = performance.now();
  await waitForInteractiveQuietBeforeBackgroundWork("benchmark:busy-agent", {
    minQuietMs: 1500,
    maxWaitMs: 5000,
    pollMs: 250,
  });
  const elapsed = performance.now() - t0;

  leaveInteractiveHotPath("agent:stream");

  console.log("Interactive wait poll benchmark (agent busy entire 5s max wait)\n");
  console.log(`Wall time: ${elapsed.toFixed(1)}ms (expect ~5000ms)`);
  console.log(
    "Overhead is the 250ms polling + dynamic import countRunningAgentStreams per tick.",
  );
  console.log("This does NOT run vault/sync — only the wait loop.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
