#!/usr/bin/env node
/**
 * Health check for local or deployed app-repo-writer.
 *
 * Usage:
 *   node scripts/test-app-repo-writer-health.mjs
 *   PAPR_APP_REPO_WRITER_URL=https://sync.papr.ai node scripts/test-app-repo-writer-health.mjs
 */

const baseUrl = (
  process.env.PAPR_APP_REPO_WRITER_URL ??
  process.env.SYNC_WRITER_URL ??
  "http://127.0.0.1:8789"
).replace(/\/$/, "");

async function main() {
  const resp = await fetch(`${baseUrl}/health`);
  const body = await resp.text();
  if (!resp.ok) {
    console.error(`Health check failed (${resp.status}): ${body}`);
    process.exit(1);
  }
  console.log(`app-repo-writer healthy: ${body}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
