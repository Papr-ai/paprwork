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

  const macZips = [...assetNames].filter((n) => n.endsWith("-mac.zip"));
  const macPkgs = [...assetNames].filter((n) => n.endsWith("-mac.pkg"));
  const winExes = [...assetNames].filter((n) => n.endsWith(".exe"));
  const linuxImages = [...assetNames].filter((n) => n.endsWith(".AppImage"));
  const linuxDebs = [...assetNames].filter((n) => n.endsWith(".deb"));

  if (macZips.length >= 2) {
    for (const name of macZips) console.log(`✓ ${name}`);
  } else {
    console.error(`✗ Expected 2 Mac zip artifacts (arm64 + x64), found ${macZips.length}`);
    failed = true;
  }

  if (macPkgs.length >= 2) {
    for (const name of macPkgs) console.log(`✓ ${name}`);
  } else {
    console.error(`✗ Expected 2 Mac pkg artifacts (arm64 + x64), found ${macPkgs.length}`);
    failed = true;
  }

  if (winExes.length >= 1) {
    console.log(`✓ ${winExes[0]}`);
  } else {
    console.error("✗ Missing Windows installer (.exe)");
    failed = true;
  }

  if (linuxImages.length >= 1) {
    console.log(`✓ ${linuxImages[0]}`);
  } else {
    console.error("✗ Missing Linux AppImage");
    failed = true;
  }

  if (linuxDebs.length >= 1) {
    console.log(`✓ ${linuxDebs[0]}`);
  } else {
    console.error("✗ Missing Linux deb package");
    failed = true;
  }

  // Also verify CDN download for Mac metadata
  const macYmlUrl = `https://github.com/${repo}/releases/download/${tag}/latest-mac.yml`;
  if (await headOk(macYmlUrl)) {
    console.log(`✓ latest-mac.yml downloadable from CDN`);
    const ymlText = await (await fetch(macYmlUrl)).text();
    const ymlUrls = [...ymlText.matchAll(/^\s+- url: (.+)$/gm)].map((m) => m[1]);
    for (const url of ymlUrls) {
      if (assetNames.has(url)) {
        console.log(`✓ yml url exists on release: ${url}`);
      } else {
        console.error(`✗ latest-mac.yml references missing asset: ${url}`);
        failed = true;
      }
      const downloadUrl = `https://github.com/${repo}/releases/download/${tag}/${url}`;
      if (await headOk(downloadUrl)) {
        console.log(`✓ downloadable: ${url}`);
      } else {
        console.error(`✗ 404 on CDN: ${url}`);
        failed = true;
      }
    }
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
