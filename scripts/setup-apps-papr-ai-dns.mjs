#!/usr/bin/env node
/**
 * Map apps.papr.ai → Cloud Run (papr-cloud-app-host) and update Route53 DNS.
 *
 * Prerequisites:
 *   1. papr.ai verified in Google Search Console for your Google account
 *      (gcloud domains list-user-verified should list papr.ai)
 *   2. AWS credentials with Route53 access (aws login / configured profile)
 *
 * Usage:
 *   node scripts/setup-apps-papr-ai-dns.mjs
 *   node scripts/setup-apps-papr-ai-dns.mjs --dry-run
 *   node scripts/setup-apps-papr-ai-dns.mjs --skip-route53   # mapping only
 */

import { execSync, spawnSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipRoute53 = args.includes("--skip-route53");

const PROJECT = "gen-lang-client-0873281406";
const REGION = "us-west1";
const SERVICE = "papr-cloud-app-host";
const DOMAIN = "apps.papr.ai";
const HOSTED_ZONE_NAME = "papr.ai.";

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  if (dryRun) return "";
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

console.log("apps.papr.ai DNS setup");
console.log("=".repeat(60));

console.log("\n--- Step 1: Check Google domain verification ---");
const verified = run("gcloud domains list-user-verified 2>/dev/null") ?? "";
const hasBaseDomain = verified.includes("papr.ai");
if (!hasBaseDomain) {
  console.log(
    [
      "⚠️  gcloud does not see papr.ai verified yet.",
      "",
      "Search Console often shows apps.papr.ai (URL prefix) as verified, but Cloud Run",
      "requires the BASE domain papr.ai as a Domain property — not just the subdomain.",
      "",
      "Fix (~2 min):",
      "  1. Search Console → Add property → Domain → papr.ai",
      "  2. Verify via DNS TXT (papr.ai already has google-site-verification TXT records)",
      "  3. Confirm: gcloud domains list-user-verified  →  should list papr.ai",
      "",
      "Attempting domain mapping anyway in case verification just synced...",
    ].join("\n"),
  );
} else {
  console.log("✓ papr.ai verified for gcloud");
}

console.log("\n--- Step 2: Create Cloud Run domain mapping ---");
const existing = spawnSync(
  "gcloud",
  [
    "beta",
    "run",
    "domain-mappings",
    "describe",
    `--domain=${DOMAIN}`,
    `--region=${REGION}`,
    `--project=${PROJECT}`,
  ],
  { encoding: "utf8" },
);
if (existing.status !== 0) {
  run(
    `gcloud beta run domain-mappings create --service=${SERVICE} --domain=${DOMAIN} --region=${REGION} --project=${PROJECT}`,
  );
  console.log("✓ Domain mapping created");
} else {
  console.log("✓ Domain mapping already exists");
}

const mappingJson = run(
  `gcloud beta run domain-mappings describe --domain=${DOMAIN} --region=${REGION} --project=${PROJECT} --format=json`,
);
const mapping = JSON.parse(mappingJson || "{}");
const records = mapping.status?.resourceRecords ?? [];
if (records.length === 0) {
  fail("Domain mapping has no resourceRecords yet — wait a minute and retry");
}

const aRecords = records.filter((r) => r.type === "A").map((r) => r.rrdata);
const aaaaRecords = records.filter((r) => r.type === "AAAA").map((r) => r.rrdata);

console.log("\nDNS records from Cloud Run:");
for (const r of records) {
  console.log(`  ${r.type}  ${r.rrdata}`);
}

if (skipRoute53) {
  console.log("\n--skip-route53: done (apply DNS manually in Route53)");
  process.exit(0);
}

console.log("\n--- Step 3: Update Route53 (apps.papr.ai) ---");
let zoneId;
try {
  const zonesJson = run(
    `aws route53 list-hosted-zones-by-name --dns-name ${HOSTED_ZONE_NAME} --output json`,
  );
  const zones = JSON.parse(zonesJson || "{}").HostedZones ?? [];
  const zone = zones.find((z) => z.Name === HOSTED_ZONE_NAME);
  if (!zone) fail(`Hosted zone not found for ${HOSTED_ZONE_NAME}`);
  zoneId = zone.Id.replace("/hostedzone/", "");
  console.log(`✓ Hosted zone: ${zoneId}`);
} catch (err) {
  fail(
    [
      "AWS Route53 access failed. Run: aws login",
      String(err),
    ].join("\n"),
  );
}

const changes = {
  Comment: `Point ${DOMAIN} to Cloud Run ${SERVICE}`,
  Changes: [
    {
      Action: "UPSERT",
      ResourceRecordSet: {
        Name: DOMAIN,
        Type: "A",
        TTL: 300,
        ResourceRecords: aRecords.map((ip) => ({ Value: ip })),
      },
    },
    ...(aaaaRecords.length > 0
      ? [
          {
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: DOMAIN,
              Type: "AAAA",
              TTL: 300,
              ResourceRecords: aaaaRecords.map((ip) => ({ Value: ip })),
            },
          },
        ]
      : []),
  ],
};

if (dryRun) {
  console.log("\nRoute53 change batch (dry-run):");
  console.log(JSON.stringify(changes, null, 2));
  process.exit(0);
}

const changeFile = `/tmp/apps-papr-ai-route53-${Date.now()}.json`;
writeFileSync(changeFile, JSON.stringify(changes));
try {
  const result = run(
    `aws route53 change-resource-record-sets --hosted-zone-id ${zoneId} --change-batch file://${changeFile} --output json`,
  );
  const changeId = JSON.parse(result || "{}").ChangeInfo?.Id;
  console.log(`✓ Route53 change submitted: ${changeId ?? "(see output)"}`);
} finally {
  unlinkSync(changeFile);
}

console.log("\n--- Step 4: Wait for mapping + TLS ---");
console.log("Certificate provisioning usually takes 5–30 minutes.");
console.log(`Check: gcloud beta run domain-mappings describe --domain=${DOMAIN} --region=${REGION} --project=${PROJECT}`);
console.log(`Test:  curl -sf https://${DOMAIN}/health`);

console.log("\n" + "=".repeat(60));
console.log("✅ DNS setup complete (propagation may take a few minutes)");
