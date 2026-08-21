#!/usr/bin/env node
/**
 * Deploy app-repo-writer to GCP Cloud Run (Sync V3 Phase 2).
 *
 * Auth: user Papr API key only (no shared secret on desktop).
 *
 * GitHub App secrets (Secret Manager, auto-created on first deploy):
 *   github-app-id, github-app-install-id, github-app-private-key
 *   Sourced from .env.local or ../memory/.env (GITHUB_APP_*).
 *
 * Usage:
 *   node scripts/deploy-cloud-app-repo-writer.mjs --project=papr-apps-prod --region=us-west1
 *   node scripts/deploy-cloud-app-repo-writer.mjs --fast --project=...   # env/secrets only
 *   node scripts/deploy-cloud-app-repo-writer.mjs --refresh-github-secrets # push new secret versions from env
 */

import { execSync, spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const GITHUB_SECRET_SPECS = [
  { secretName: "github-app-id", envVar: "GITHUB_APP_ID" },
  { secretName: "github-app-install-id", envVar: "GITHUB_APP_INSTALL_ID" },
  { secretName: "github-app-private-key", envVar: "GITHUB_APP_PRIVATE_KEY" },
];

function loadEnvFile(envPath, keysOnly) {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (keysOnly && !keysOnly.includes(key)) continue;
    if (process.env[key]) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadEnvLocal() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
}

function loadGithubAppEnvFallback() {
  const memoryEnv = resolve(process.cwd(), "../memory/.env");
  if (!existsSync(memoryEnv)) return;
  const missing = GITHUB_SECRET_SPECS.some((s) => !process.env[s.envVar]?.trim());
  if (!missing) return;
  console.log("Loading missing GITHUB_APP_* from ../memory/.env");
  loadEnvFile(memoryEnv, GITHUB_SECRET_SPECS.map((s) => s.envVar));
}

loadEnvLocal();
loadGithubAppEnvFallback();

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const dryRun = args.includes("--dry-run");
const fastDeploy = args.includes("--fast");
const refreshGithubSecrets = args.includes("--refresh-github-secrets");

const project = getArg("project", process.env.GCP_APPS_PROJECT_ID);
const region = getArg("region", process.env.GCP_APPS_REGION ?? "us-west1");
const service = getArg("service", "app-repo-writer");
const memoryUrl =
  getArg("memory-url", process.env.PAPR_MEMORY_SERVER_URL) ??
  "https://memory.papr.ai";
const appHostUrl = (
  getArg("app-host-url", process.env.PAPR_CLOUD_APPS_HOST) ??
  "https://papr-cloud-app-host-223473570766.us-west1.run.app"
).replace(/\/$/, "");
const skipWebhook = args.includes("--skip-webhook");
const committedWebhookUrl = skipWebhook
  ? ""
  : (
      getArg(
        "committed-webhook-url",
        process.env.PAPR_APP_REPO_COMMITTED_WEBHOOK_URL,
      ) ?? `${appHostUrl}/internal/app-repo-committed`
    ).replace(/\/$/, "");
const appHostSecretName = "papr-cloud-app-host-key";

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  if (dryRun) return;
  execSync(cmd, { stdio: "inherit" });
}

function secretExists(secretName) {
  const check = spawnSync(
    "gcloud",
    ["secrets", "describe", secretName, `--project=${project}`],
    { encoding: "utf8" },
  );
  return check.status === 0;
}

function readEnvValue(envVar) {
  const raw = process.env[envVar]?.trim();
  if (!raw) return null;
  if (envVar === "GITHUB_APP_PRIVATE_KEY") {
    return raw.replace(/\\n/g, "\n");
  }
  return raw;
}

function createOrRefreshSecret(secretName, envVar) {
  const value = readEnvValue(envVar);
  const exists = secretExists(secretName);

  if (refreshGithubSecrets && value) {
    if (dryRun) {
      console.log(`(dry-run: would add secret version ${secretName} from ${envVar})`);
      return true;
    }
    if (!exists) {
      const create = spawnSync(
        "gcloud",
        ["secrets", "create", secretName, "--data-file=-", `--project=${project}`],
        { input: value, encoding: "utf8" },
      );
      if (create.status !== 0) {
        fail(`Failed to create secret ${secretName}: ${create.stderr?.trim() ?? "unknown"}`);
      }
      console.log(`Created secret ${secretName} from ${envVar}`);
      return true;
    }
    const add = spawnSync(
      "gcloud",
      [
        "secrets",
        "versions",
        "add",
        secretName,
        "--data-file=-",
        `--project=${project}`,
      ],
      { input: value, encoding: "utf8" },
    );
    if (add.status !== 0) {
      fail(`Failed to update secret ${secretName}: ${add.stderr?.trim() ?? "unknown"}`);
    }
    console.log(`Updated secret ${secretName} from ${envVar}`);
    return true;
  }

  if (exists) {
    console.log(`Secret ${secretName} exists`);
    return true;
  }

  if (!value) {
    fail(
      `Secret ${secretName} missing — set ${envVar} in .env.local or ../memory/.env, then redeploy`,
    );
  }

  if (dryRun) {
    console.log(`(dry-run: would create secret ${secretName} from ${envVar})`);
    return true;
  }

  const create = spawnSync(
    "gcloud",
    ["secrets", "create", secretName, "--data-file=-", `--project=${project}`],
    { input: value, encoding: "utf8" },
  );
  if (create.status !== 0) {
    fail(`Failed to create secret ${secretName}: ${create.stderr?.trim() ?? "unknown"}`);
  }
  console.log(`Created secret ${secretName} from ${envVar}`);
  return true;
}

function grantComputeSecretAccess(secretNames) {
  if (dryRun || secretNames.length === 0) return;
  const projectNumber = execSync(
    `gcloud projects describe ${project} --format='value(projectNumber)'`,
    { encoding: "utf8" },
  ).trim();
  const computeSa = `${projectNumber}-compute@developer.gserviceaccount.com`;
  for (const secretName of secretNames) {
    run(
      `gcloud secrets add-iam-policy-binding ${secretName} --project=${project} --member=serviceAccount:${computeSa} --role=roles/secretmanager.secretAccessor --quiet`,
    );
  }
}

if (!project) {
  fail("Missing --project or GCP_APPS_PROJECT_ID");
}

const imageTag = getArg("tag", "latest");
const repoName = getArg("repo", "papr-apps");
const registry = `${region}-docker.pkg.dev`;
const fullImage = `${registry}/${project}/${repoName}/${service}:${imageTag}`;

console.log("app-repo-writer — Cloud Run deploy (Phase 2)");
console.log("=".repeat(60));
console.log(`Project:  ${project}`);
console.log(`Region:   ${region}`);
console.log(`Service:  ${service}`);
console.log(`Image:    ${fullImage}`);
console.log(`Memory:   ${memoryUrl}`);
console.log(`Webhook:  ${skipWebhook ? "(disabled)" : committedWebhookUrl}`);
if (fastDeploy) console.log("Mode:     FAST (env/secrets only — skip image build)");
if (refreshGithubSecrets) console.log("Mode:     refresh GitHub secrets from env");

run(
  `gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project=${project}`,
);

const repoCheck = spawnSync(
  "gcloud",
  ["artifacts", "repositories", "describe", repoName, `--location=${region}`, `--project=${project}`],
  { encoding: "utf8" },
);
if (repoCheck.status !== 0) {
  run(
    `gcloud artifacts repositories create ${repoName} --repository-format=docker --location=${region} --project=${project}`,
  );
} else {
  console.log(`Repository ${repoName} already exists`);
}

let deployImage = fullImage;
if (fastDeploy) {
  const existing = spawnSync(
    "gcloud",
    [
      "run",
      "services",
      "describe",
      service,
      `--region=${region}`,
      `--project=${project}`,
      "--format=value(spec.template.spec.containers[0].image)",
    ],
    { encoding: "utf8" },
  );
  if (existing.status !== 0 || !existing.stdout.trim()) {
    fail("--fast requires an existing Cloud Run service — run a full deploy first");
  }
  deployImage = existing.stdout.trim();
  console.log(`Reusing image: ${deployImage}`);
} else {
  run(
    `gcloud builds submit --project=${project} --region=${region} --config=cloudbuild-cloud-app-repo-writer.yaml --substitutions=_IMAGE=${fullImage} .`,
  );
}

console.log("\n--- GitHub App secrets ---");
for (const spec of GITHUB_SECRET_SPECS) {
  createOrRefreshSecret(spec.secretName, spec.envVar);
}

const appHostSecretCheck = spawnSync(
  "gcloud",
  ["secrets", "describe", appHostSecretName, `--project=${project}`],
  { encoding: "utf8" },
);
if (!skipWebhook && appHostSecretCheck.status !== 0) {
  fail(
    `Secret ${appHostSecretName} missing — deploy cloud-app-host first or pass --skip-webhook`,
  );
}

const allSecretNames = [
  ...GITHUB_SECRET_SPECS.map((s) => s.secretName),
  ...(appHostSecretCheck.status === 0 ? [appHostSecretName] : []),
];
grantComputeSecretAccess(allSecretNames);

const envVars = [`PAPR_MEMORY_SERVER_URL=${memoryUrl}`];
if (committedWebhookUrl) {
  envVars.push(`PAPR_APP_REPO_COMMITTED_WEBHOOK_URL=${committedWebhookUrl}`);
}

const secretBindings = [
  ...GITHUB_SECRET_SPECS.map(
    (s) => `${s.envVar}=${s.secretName}:latest`,
  ),
  ...(appHostSecretCheck.status === 0
    ? [`PAPR_CLOUD_APP_HOST_KEY=${appHostSecretName}:latest`]
    : []),
].join(",");

run(
  `gcloud run deploy ${service} \
    --project=${project} \
    --region=${region} \
    --image=${deployImage} \
    --platform=managed \
    --allow-unauthenticated \
    --port=8080 \
    --memory=1Gi \
    --cpu=1 \
    --timeout=300 \
    --concurrency=1 \
    --max-instances=1 \
    --set-env-vars=${envVars.join(",")} \
    --set-secrets=${secretBindings}`,
);

console.log("\n✅ Deploy complete. Set PAPR_APP_REPO_WRITER_URL on desktop after dogfood.");
if (committedWebhookUrl) {
  console.log(`   Webhook → ${committedWebhookUrl}`);
}
console.log("   GitHub secrets → github-app-id, github-app-install-id, github-app-private-key");
