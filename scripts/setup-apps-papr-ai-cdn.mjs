#!/usr/bin/env node
/**
 * Put Cloud CDN in front of apps.papr.ai (Phase 4).
 *
 * Creates a global HTTPS load balancer with a serverless NEG → Cloud Run backend
 * and enables Cloud CDN for static assets. After this script, point DNS at the LB IP
 * instead of Cloud Run domain mapping (or keep domain mapping for TLS fallback).
 *
 * Prerequisites:
 *   - gcloud CLI authenticated
 *   - Cloud App Host deployed to Cloud Run (see deploy-cloud-app-host.mjs)
 *
 * Usage:
 *   node scripts/setup-apps-papr-ai-cdn.mjs --project=papr-apps-prod --region=us-west1
 *   node scripts/setup-apps-papr-ai-cdn.mjs --dry-run
 *
 * Options:
 *   --project=ID       GCP project (required)
 *   --region=REGION    Cloud Run region (default: us-west1)
 *   --service=NAME     Cloud Run service (default: papr-cloud-app-host)
 *   --domain=HOST      Public hostname (default: apps.papr.ai)
 *   --dry-run          Print commands without executing
 */

import { execSync, spawnSync } from "child_process";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const dryRun = args.includes("--dry-run");

const project = getArg("project", process.env.GCP_APPS_PROJECT_ID);
const region = getArg("region", process.env.GCP_APPS_REGION ?? "us-west1");
const service = getArg("service", "papr-cloud-app-host");
const domain = getArg("domain", "apps.papr.ai");

const negName = "papr-cloud-app-host-neg";
const backendName = "papr-cloud-app-host-backend";
const urlMapName = "papr-cloud-app-host-urlmap";
const certName = "papr-apps-papr-ai-cert";
const proxyName = "papr-cloud-app-host-https-proxy";
const forwardingRuleName = "papr-cloud-app-host-https-rule";

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  if (dryRun) return "";
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

if (!project) {
  fail("Missing --project=YOUR_GCP_PROJECT (or GCP_APPS_PROJECT_ID env var)");
}

console.log("apps.papr.ai — Cloud CDN setup (Phase 4)");
console.log("=".repeat(60));
console.log(`Project:  ${project}`);
console.log(`Region:   ${region}`);
console.log(`Service:  ${service}`);
console.log(`Domain:   ${domain}`);
if (dryRun) console.log("Mode:     DRY RUN");

console.log("\n--- Step 1: Enable APIs ---");
run(
  `gcloud services enable compute.googleapis.com certificatemanager.googleapis.com --project=${project}`,
);

console.log("\n--- Step 2: Serverless NEG → Cloud Run ---");
const negCheck = spawnSync(
  "gcloud",
  [
    "compute",
    "network-endpoint-groups",
    "describe",
    negName,
    `--region=${region}`,
    `--project=${project}`,
  ],
  { encoding: "utf8" },
);
if (negCheck.status !== 0) {
  run(
    `gcloud compute network-endpoint-groups create ${negName} --region=${region} --network-endpoint-type=serverless --cloud-run-service=${service} --project=${project}`,
  );
} else {
  console.log(`NEG ${negName} already exists`);
}

console.log("\n--- Step 3: Backend service with Cloud CDN ---");
const backendCheck = spawnSync(
  "gcloud",
  ["compute", "backend-services", "describe", backendName, "--global", `--project=${project}`],
  { encoding: "utf8" },
);
if (backendCheck.status !== 0) {
  run(
    `gcloud compute backend-services create ${backendName} --global --load-balancing-scheme=EXTERNAL_MANAGED --project=${project}`,
  );
  run(
    `gcloud compute backend-services add-backend ${backendName} --global --network-endpoint-group=${negName} --network-endpoint-group-region=${region} --project=${project}`,
  );
} else {
  console.log(`Backend ${backendName} already exists`);
}

run(
  `gcloud compute backend-services update ${backendName} --global --enable-cdn --cache-mode=CACHE_ALL_STATIC --default-ttl=3600 --max-ttl=31536000 --client-ttl=3600 --project=${project}`,
);

console.log("\n--- Step 4: URL map + managed certificate ---");
run(
  `gcloud compute url-maps create ${urlMapName} --default-service=${backendName} --global --project=${project} 2>/dev/null || true`,
);
run(
  `gcloud compute ssl-certificates create ${certName} --domains=${domain} --global --project=${project} 2>/dev/null || true`,
);
run(
  `gcloud compute target-https-proxies create ${proxyName} --url-map=${urlMapName} --ssl-certificates=${certName} --global --project=${project} 2>/dev/null || true`,
);

console.log("\n--- Step 5: Global forwarding rule (LB IP) ---");
const ip = run(
  `gcloud compute forwarding-rules describe ${forwardingRuleName} --global --project=${project} --format='value(IPAddress)' 2>/dev/null || gcloud compute addresses create papr-apps-lb-ip --global --project=${project} && gcloud compute forwarding-rules create ${forwardingRuleName} --load-balancing-scheme=EXTERNAL_MANAGED --network-tier=PREMIUM --address=papr-apps-lb-ip --target-https-proxy=${proxyName} --ports=443 --global --project=${project} && gcloud compute addresses describe papr-apps-lb-ip --global --project=${project} --format='value(address)'`,
);

console.log("\n" + "=".repeat(60));
console.log("✅ Cloud CDN load balancer configured");
console.log(`\nNext steps:`);
console.log(`  1. Point ${domain} A record → ${ip || "(LB IP — run describe forwarding-rules)"}`);
console.log(`  2. Wait 5–30 min for managed cert provisioning`);
console.log(`  3. Verify: curl -sf https://${domain}/health`);
console.log(`\nNote: index.html stays no-cache (auth gate). dist/* assets cache at edge.`);
