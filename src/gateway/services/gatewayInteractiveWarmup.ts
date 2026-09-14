/**
 * Prefetch credentials and hybrid storage after the UI connects so the first
 * chat message does not pay IPC + storage upgrade latency.
 */

let warmupStarted = false;

export function scheduleGatewayInteractiveWarmup(): void {
  if (warmupStarted) {
    return;
  }
  warmupStarted = true;

  void runGatewayInteractiveWarmup().catch((err) => {
    console.warn(
      "[GatewayWarmup] Failed:",
      err instanceof Error ? err.message : err,
    );
  });
}

async function runGatewayInteractiveWarmup(): Promise<void> {
  const startedAt = performance.now();
  const { getApiKeys, getProviderAuth } = await import("../utils/keyResolver.js");

  await getApiKeys(["PAPR_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
  await Promise.all([
    getProviderAuth("openai"),
    getProviderAuth("anthropic"),
  ]);

  const { getAgentService } = await import("./AgentService.js");
  await getAgentService().warmHybridStorageFromPaprKey();

  console.log(
    `[GatewayWarmup] Credentials + storage warm complete in ${(performance.now() - startedAt).toFixed(0)}ms`,
  );
}
