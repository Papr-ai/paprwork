/**
 * Search defaults for latency.
 *
 * - Agentic graph search is OFF by default for memory search. A cold call measured 5.8 s
 *   vs 0.4–0.7 s without it, and it adds little for recall. Opt in: PAPR_AGENTIC_GRAPH=1.
 * - The cloud memory search that grep ran alongside every Papr-folder grep is OFF by
 *   default. In 45 greps since Nov 6 it returned results 4 times and never surfaced a
 *   file the on-device search or grep did not already show; it was most of the 6.9 s
 *   worst case. On-device papr-embed (73 ms) + grep + Jev cover it. Opt in:
 *   PAPR_GREP_CLOUD_MEMORY=1.
 */
const on = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";

export function agenticGraphEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return on(env.PAPR_AGENTIC_GRAPH);
}

export function grepCloudMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return on(env.PAPR_GREP_CLOUD_MEMORY);
}
