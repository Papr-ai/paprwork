#!/usr/bin/env node
/**
 * Deploy Cloud Agent Gateway to GCP Cloud Run
 *
 * Usage:
 *   node scripts/deploy-cloud-agent-gateway.mjs --project=papr-apps-prod --region=us-west1
 *
 * Options:
 *   --project=ID          GCP project (required)
 *   --region=REGION       Cloud Run region (default: us-west1)
 *   --service=NAME        Service name (default: papr-cloud-agent-gateway)
 *   --repo=REPO           Artifact Registry repo (default: papr-apps)
 *   --image=NAME          Image name (default: cloud-agent-gateway)
 *   --memory-url=URL      Memory server URL (default: https://memory.papr.ai)
 *   --memory-service=NAME Cloud Run service to wire CLOUD_AGENT_GATEWAY_URL (default: memoryserver-staging)
 *   --skip-memory-wire    Skip updating memory Cloud Run env after deploy
 *   --dry-run             Print commands without executing
 */

import { execSync, spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

function loadEnvLocal() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvLocal();

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const dryRun = args.includes("--dry-run");

const project = getArg("project", process.env.GCP_APPS_PROJECT_ID);
const region = getArg("region", process.env.GCP_APPS_REGION ?? "us-west1");
const service = getArg("service", "papr-cloud-agent-gateway");
const repo = getArg("repo", "papr-apps");
const imageName = getArg("image", "cloud-agent-gateway");
const memoryUrl = getArg("memory-url", "https://memory.papr.ai");
const memoryService = getArg("memory-service", "memoryserver-staging");
const skipMemoryWire = args.includes("--skip-memory-wire");

function gitShortSha() {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return `manual-${Date.now()}`;
  }
}

const tag = getArg("tag", gitShortSha());
const registry = `${region}-docker.pkg.dev`;
const fullImage = `${registry}/${project}/${repo}/${imageName}:${tag}`;

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  if (dryRun) return "";
  return execSync(cmd, { stdio: "inherit", encoding: "utf8", ...opts });
}

function runCapture(cmd) {
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

console.log("Cloud Agent Gateway — production deploy");
console.log("=".repeat(60));
console.log(`Project:     ${project}`);
console.log(`Region:      ${region}`);
console.log(`Service:     ${service}`);
console.log(`Image:       ${fullImage}`);
console.log(`Memory URL:  ${memoryUrl}`);
if (dryRun) console.log("Mode:        DRY RUN");

console.log("\n--- Pre-flight checklist ---");
console.log("[ ] PAPR_CLOUD_AGENT_GATEWAY_KEY on memory Cloud Run (same value as gateway)");
console.log("[ ] Memory CLOUD_AGENT_GATEWAY_URL points to this service URL after deploy");
console.log("[ ] Vault synced with OPENAI_API_KEY / ANTHROPIC_API_KEY (oauth label when OAuth)");
console.log("[ ] Gateway image includes Playwright Chromium (browser_* tools in cloud jobs)");

console.log("\n--- Step 1: Enable APIs ---");
run(
  `gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project=${project}`,
);

console.log("\n--- Step 2: Artifact Registry (if missing) ---");
const repoCheck = spawnSync(
  "gcloud",
  ["artifacts", "repositories", "describe", repo, `--location=${region}`, `--project=${project}`],
  { encoding: "utf8" },
);
if (repoCheck.status !== 0) {
  run(
    `gcloud artifacts repositories create ${repo} --repository-format=docker --location=${region} --project=${project}`,
  );
} else {
  console.log(`Repository ${repo} already exists`);
}

run(`gcloud auth configure-docker ${registry} --quiet`);

const secretName = "papr-cloud-agent-gateway-key";

console.log("\n--- Step 3: Gateway key secret ---");
const secretCheck = spawnSync(
  "gcloud",
  ["secrets", "describe", secretName, `--project=${project}`],
  { encoding: "utf8" },
);
if (secretCheck.status !== 0) {
  const existingKey = process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY;
  if (!existingKey && !dryRun) {
    fail(
      "PAPR_CLOUD_AGENT_GATEWAY_KEY not set — add to .env.local (must match memory Cloud Run) before first deploy",
    );
  }
  if (dryRun) {
    console.log("(dry-run: would create secret from PAPR_CLOUD_AGENT_GATEWAY_KEY in .env.local)");
  } else {
    console.log(`Creating secret ${secretName} from PAPR_CLOUD_AGENT_GATEWAY_KEY (.env.local)`);
    run(
      `printf '%s' '${existingKey.replace(/'/g, "'\\''")}' | gcloud secrets create ${secretName} --data-file=- --project=${project}`,
    );
  }
} else {
  console.log(`Secret ${secretName} exists — ensure value matches memory Cloud Run`);
}

const computeSa = `${runCapture(`gcloud projects describe ${project} --format='value(projectNumber)'`)}-compute@developer.gserviceaccount.com`;
const memorySa =
  getArg("memory-sa", process.env.CLOUD_MEMORY_RUN_SA) ??
  "cloud-run-webapp-sa@gen-lang-client-0873281406.iam.gserviceaccount.com";

console.log("\n--- Step 3b: Secret + Run IAM ---");
run(
  `gcloud secrets add-iam-policy-binding ${secretName} --project=${project} --member=serviceAccount:${computeSa} --role=roles/secretmanager.secretAccessor --quiet`,
);
run(
  `gcloud secrets add-iam-policy-binding ${secretName} --project=${project} --member=serviceAccount:${memorySa} --role=roles/secretmanager.secretAccessor --quiet`,
);

console.log("\n--- Step 4: Build & push Docker image ---");
run(`docker build --platform linux/amd64 -f Dockerfile.cloud-agent-gateway -t ${fullImage} .`, {
  cwd: resolve(process.cwd()),
});
run(`docker push ${fullImage}`);

console.log("\n--- Step 5: Deploy Cloud Run ---");
const deployCmd = [
  "gcloud run deploy",
  service,
  `--image=${fullImage}`,
  `--region=${region}`,
  `--project=${project}`,
  "--platform=managed",
  "--no-allow-unauthenticated",
  "--port=8080",
  "--memory=2Gi",
  "--cpu=2",
  "--min-instances=0",
  "--max-instances=10",
  "--timeout=900",
  "--concurrency=1",
  `--set-secrets=PAPR_CLOUD_AGENT_GATEWAY_KEY=${secretName}:latest`,
  `--set-env-vars=GATEWAY_MODE=cloud_agent,CLOUD_SYNC_ENABLED=false,PAPR_MEMORY_SERVER_URL=${memoryUrl},TURSO_SYNC_ENABLED=false,NODE_ENV=production`,
].join(" ");

run(deployCmd);

console.log("\n--- Step 5b: Cloud Run invoker IAM ---");
if (!dryRun) {
  run(
    `gcloud run services add-iam-policy-binding ${service} --region=${region} --project=${project} --member=serviceAccount:${memorySa} --role=roles/run.invoker --quiet`,
  );
}

const serviceUrl = dryRun
  ? "https://SERVICE_URL"
  : runCapture(
      `gcloud run services describe ${service} --region=${region} --project=${project} --format='value(status.url)'`,
    );

console.log("\n--- Step 6: Verify ---");
console.log(`curl -H "X-Cloud-Agent-Gateway-Key: \$KEY" ${serviceUrl}/health`);
if (!dryRun) {
  try {
    const key =
      process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY ??
      runCapture(
        `gcloud secrets versions access latest --secret=${secretName} --project=${project}`,
      );
    const health = runCapture(
      `curl -sf -H "X-Cloud-Agent-Gateway-Key: ${key}" ${serviceUrl}/health`,
    );
    console.log("Health:", health);
  } catch {
    console.log("⚠️  Health check failed — service may still be starting");
  }
}

if (!skipMemoryWire) {
  console.log(`\n--- Step 7: Wire memory Cloud Run (${memoryService}) ---`);
  const wireCmd = [
    "gcloud run services update",
    memoryService,
    `--region=${region}`,
    `--project=${project}`,
    `--update-env-vars=CLOUD_AGENT_GATEWAY_URL=${serviceUrl}`,
    `--update-secrets=PAPR_CLOUD_AGENT_GATEWAY_KEY=${secretName}:latest`,
    "--quiet",
  ].join(" ");
  run(wireCmd);
  console.log(`✅ ${memoryService} → CLOUD_AGENT_GATEWAY_URL=${serviceUrl}`);
}

console.log("\n" + "=".repeat(60));
console.log("✅ Cloud Agent Gateway deployed");
if (skipMemoryWire) {
  console.log("\nNEXT (manual):");
  console.log(`1. Set memory Cloud Run env: CLOUD_AGENT_GATEWAY_URL=${serviceUrl}`);
  console.log("2. Ensure PAPR_CLOUD_AGENT_GATEWAY_KEY matches on memory + gateway");
  console.log("3. Run scheduled agent job and verify git writeback + Turso push");
} else {
  console.log(`\nMemory service ${memoryService} wired. For production (memory.papr.ai), repeat Step 7 on that Cloud Run service if different.`);
  console.log("\nE2E:");
  console.log(`  export PAPR_CLOUD_AGENT_GATEWAY_KEY="$(gcloud secrets versions access latest --secret=${secretName} --project=${project})"`);
  console.log(`  node scripts/test-cloud-agent-job-e2e.mjs --gateway=${serviceUrl} --e2e-prompt`);
  console.log(`  node scripts/test-cloud-agent-job-e2e.mjs --gateway=${serviceUrl} --browser-e2e --e2e-prompt`);
}
