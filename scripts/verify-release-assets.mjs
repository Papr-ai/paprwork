#!/usr/bin/env node
/**
 * Verify a GitHub release has auto-update metadata (latest-*.yml).
 *
 * Usage:
 *   node scripts/verify-release-assets.mjs v2.3.0
 *   npm run verify:release -- v2.3.0
 */

const tag = process.argv[2];
if (!tag) {
  console.error("Usage: node scripts/verify-release-assets.mjs <tag>");
  console.error("Example: node scripts/verify-release-assets.mjs v2.3.0");
  process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY ?? "Papr-ai/paprwork";
const required = ["latest-mac.yml", "latest.yml", "latest-linux.yml"];
const recommended = [".pkg", ".exe", ".AppImage"];

async function headOk(url) {
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  return res.ok;
}

async function main() {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const res = await fetch(apiUrl, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    console.error(`Release ${tag} not found (${res.status})`);
    process.exit(1);
  }

  const release = await res.json();
  const assetNames = new Set(
    (release.assets ?? []).map((a) => a.name),
  );

  let failed = false;

  for (const file of required) {
    if (assetNames.has(file)) {
      console.log(`✓ ${file}`);
    } else {
      console.error(`✗ MISSING (required): ${file}`);
      failed = true;
    }
  }

  for (const suffix of recommended) {
    const match = [...assetNames].find((n) => n.endsWith(suffix));
    if (match) {
      console.log(`✓ ${match}`);
    } else {
      console.warn(`⚠ no asset ending with ${suffix}`);
    }
  }

  // Also verify CDN download for Mac metadata
  const macYmlUrl = `https://github.com/${repo}/releases/download/${tag}/latest-mac.yml`;
  if (await headOk(macYmlUrl)) {
    console.log(`✓ latest-mac.yml downloadable from CDN`);
  } else {
    console.error(`✗ latest-mac.yml not downloadable from CDN`);
    failed = true;
  }

  if (failed) {
    process.exit(1);
  }
  console.log(`\nRelease ${tag} looks good for auto-update.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
