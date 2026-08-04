#!/usr/bin/env node
/**
 * Deploy Cloud App Host to GCP Cloud Run (apps.papr.ai)
 *
 * Prerequisites:
 *   - gcloud CLI authenticated
 *   - New GCP project created (recommended: separate from memory)
 *   - Artifact Registry repo created in apps project
 *   - Same PAPR_CLOUD_APP_HOST_KEY value set on memory Cloud Run
 *   - Auth0 callback: https://apps.papr.ai/auth/callback
 *
 * Usage:
 *   node scripts/deploy-cloud-app-host.mjs --project=papr-apps-prod --region=us-west1
 *
 * Options:
 *   --project=ID          GCP project (required)
 *   --region=REGION       Cloud Run region (default: us-west1)
 *   --service=NAME        Cloud Run service name (default: papr-cloud-app-host)
 *   --repo=REPO           Artifact Registry repo (default: papr-apps)
 *   --image=NAME          Image name (default: cloud-app-host)
 *   --tag=TAG             Image tag (default: git short sha or timestamp)
 *   --memory-url=URL      Memory server URL (default: https://memory.papr.ai)
 *   --public-url=URL      Public URL for Auth0 redirect (default: https://apps.papr.ai)
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
const service = getArg("service", "papr-cloud-app-host");
const repo = getArg("repo", "papr-apps");
const imageName = getArg("image", "cloud-app-host");
const memoryUrl = getArg("memory-url", "https://memory.papr.ai");
const publicUrl = getArg("public-url", "https://apps.papr.ai");

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

console.log("Cloud App Host — production deploy");
console.log("=".repeat(60));
console.log(`Project:     ${project}`);
console.log(`Region:      ${region}`);
console.log(`Service:     ${service}`);
console.log(`Image:       ${fullImage}`);
console.log(`Memory URL:  ${memoryUrl}`);
console.log(`Public URL:  ${publicUrl}`);
if (dryRun) console.log("Mode:        DRY RUN");

console.log("\n--- Pre-flight checklist ---");
console.log("[ ] Memory deployed with /v1/cloud/apps/runtime/* routes");
console.log("[ ] PAPR_CLOUD_APP_HOST_KEY on memory Cloud Run (same value as apps)");
console.log("[ ] Auth0 callback registered:", `${publicUrl}/auth/callback`);
console.log("[ ] DNS apps.papr.ai → Cloud Run (after first deploy)");
console.log("[ ] Paprwork desktop: cloud sync + publish enabled for test app");

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

console.log("\n--- Step 3: Host key secret ---");
const secretName = "papr-cloud-app-host-key";
const secretCheck = spawnSync(
  "gcloud",
  ["secrets", "describe", secretName, `--project=${project}`],
  { encoding: "utf8" },
);
if (secretCheck.status !== 0) {
  const existingKey = process.env.PAPR_CLOUD_APP_HOST_KEY;
  if (!existingKey && !dryRun) {
    fail(
      "PAPR_CLOUD_APP_HOST_KEY not set — add to .env.local (must match memory Cloud Run) before first deploy",
    );
  }
  if (dryRun) {
    console.log("(dry-run: would create secret from PAPR_CLOUD_APP_HOST_KEY in .env.local)");
  } else {
    console.log(`Creating secret ${secretName} from PAPR_CLOUD_APP_HOST_KEY (.env.local)`);
    run(
      `printf '%s' '${existingKey.replace(/'/g, "'\\''")}' | gcloud secrets create ${secretName} --data-file=- --project=${project}`,
    );
  }
} else {
  console.log(`Secret ${secretName} exists — ensure value matches memory Cloud Run`);
}

console.log("\n--- Step 4: Build & push Docker image ---");
const useCloudBuild = args.includes("--cloud-build") || process.env.CLOUD_APP_HOST_CLOUD_BUILD === "1";
if (useCloudBuild) {
  run(
    `gcloud builds submit --project=${project} --region=${region} --config=cloudbuild-cloud-app-host.yaml --substitutions=_IMAGE=${fullImage} .`,
    { cwd: resolve(process.cwd()) },
  );
} else {
  run(
    `docker build -f Dockerfile.cloud-app-host -t ${fullImage} .`,
    { cwd: resolve(process.cwd()) },
  );
  run(`docker push ${fullImage}`);
}

console.log("\n--- Step 5: Deploy Cloud Run ---");
const deployCmd = [
  "gcloud run deploy",
  service,
  `--image=${fullImage}`,
  `--region=${region}`,
  `--project=${project}`,
  "--platform=managed",
  "--allow-unauthenticated",
  "--port=8080",
  "--memory=512Mi",
  "--cpu=1",
  "--min-instances=1",
  "--max-instances=20",
  "--timeout=120",
  `--set-secrets=PAPR_CLOUD_APP_HOST_KEY=${secretName}:latest`,
  `--set-env-vars=PAPR_MEMORY_SERVER_URL=${memoryUrl},PAPR_CLOUD_APP_PUBLIC_URL=${publicUrl},CLOUD_APP_HOST_MEMORY_TIMEOUT_MS=90000,AUTH0_DOMAIN=papr.auth0.com,AUTH0_CLIENT_ID=asVGkVRkRAxYvtQadqivntIRjB4D1Iur,NODE_ENV=production`,
].join(" ");

run(deployCmd);

const serviceUrl = dryRun
  ? "https://SERVICE_URL"
  : runCapture(
      `gcloud run services describe ${service} --region=${region} --project=${project} --format='value(status.url)'`,
    );

console.log("\n--- Step 6: Verify ---");
console.log(`curl ${serviceUrl}/health`);
if (!dryRun) {
  try {
    const health = runCapture(`curl -sf ${serviceUrl}/health`);
    console.log("Health:", health);
  } catch {
    console.log("⚠️  Health check failed — service may still be starting");
  }
}

console.log("\n" + "=".repeat(60));
console.log("✅ Cloud App Host deployed");
console.log("\nNEXT (manual):");
console.log(`1. Memory project — set env on memory Cloud Run:`);
console.log(`   gcloud run services update memoryserver-staging \\`);
console.log(`     --region=us-west1 --project=MEMORY_PROJECT \\`);
console.log(`     --update-secrets=PAPR_CLOUD_APP_HOST_KEY=${secretName}:latest`);
console.log(`   (Use same secret VALUE in both projects)`);
console.log(`\n2. Map DNS:`);
console.log(`   apps.papr.ai → ${serviceUrl.replace("https://", "")}`);
console.log(`   (Cloud Run domain mapping or load balancer)`);
console.log(`\n3. Auth0 → Applications → add callback:`);
console.log(`   ${publicUrl}/auth/callback`);
console.log(`\n4. Smoke test from paprwork-v2:`);
console.log(`   npm run test:cloud-app-host -- --host=${serviceUrl}`);
console.log(`\n5. Enable cloud link on an app in Paprwork → open share URL → sign in`);
