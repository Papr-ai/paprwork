import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTO_DETECTED_KEY_DESCRIPTION,
  findUndeclaredKeys,
  looksLikeCredentialName,
} from "../../src/gateway/services/appKeyDeclarations.js";
import {
  checkAppKeyDeclarations,
  ensureAppRequirementsSyncedWithBackend,
  readAppNotKeys,
  readAppRequirements,
  upsertDeclaredAppKeys,
} from "../../src/gateway/services/cloudAppRequirements.js";
import { declaredKeyToSpec } from "../../src/core/tools/appKeys.js";
import type { RequiredKeySpec } from "../../src/core/types/bundles.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function spec(partial: Partial<RequiredKeySpec> & { name: string }): RequiredKeySpec {
  return {
    service: partial.name,
    category: "other",
    description: "",
    required: true,
    credentialScope: "owner",
    clientAccess: "server",
    ...partial,
  };
}

/** App linked to one job whose command uses ${TASK}, ${CAMPAIGN_JSON}, ${PROMO_SECRET} — the screenshot case. */
function makeScreenshotApp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-keys-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "apps", "app-1"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Jobs", "job-1"), { recursive: true });
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data", "jobs.json"),
    JSON.stringify({ jobs: [{ id: "job-1", name: "Promo", appIds: ["app-1"] }] }),
  );
  fs.writeFileSync(
    path.join(dir, "Jobs", "job-1", "job.json"),
    JSON.stringify({
      id: "job-1",
      command: 'python3 code/run.py --task "${TASK}" --campaign "${CAMPAIGN_JSON}" --secret "${PROMO_SECRET}"',
    }),
  );
  return dir;
}

describe("looksLikeCredentialName", () => {
  it("separates secrets from parameters", () => {
    expect(looksLikeCredentialName("PROMO_SECRET")).toBe(true);
    expect(looksLikeCredentialName("OPENAI_API_KEY")).toBe(true);
    expect(looksLikeCredentialName("LINKEDIN_LI_AT")).toBe(true);
    expect(looksLikeCredentialName("GITHUB_TOKEN")).toBe(true);
    expect(looksLikeCredentialName("TASK")).toBe(false);
    expect(looksLikeCredentialName("CAMPAIGN_JSON")).toBe(false);
    // Real keys from existing apps that the first version called parameters.
    for (const name of ["GCP_OPS_MONITOR_SA", "PAPR_SERVICE_ACCOUNT", "SLACK_WEBHOOK_URL", "LINKEDIN_JSESSIONID", "JOE_PAPR_API_KEY_V3", "RR_GDRIVE_SERVICE_ACCOUNT"]) {
      expect(looksLikeCredentialName(name), name).toBe(true);
    }
  });
});

describe("findUndeclaredKeys", () => {
  it("flags undeclared names with vault and name-shape hints", () => {
    const result = findUndeclaredKeys({
      saved: [],
      detected: [
        { name: "TASK", source: "job-command", jobId: "j" },
        { name: "PROMO_SECRET", source: "job-command", jobId: "j" },
        { name: "OPENAI_API_KEY", source: "backend" },
      ],
      notKeys: [],
      ownerVaultKeyNames: ["PROMO_SECRET"],
    });
    const byName = Object.fromEntries(result.map((k) => [k.name, k]));
    expect(byName.PROMO_SECRET?.suggestion).toBe("owner");
    expect(byName.TASK?.suggestion).toBe("not_a_key");
    // Credential-shaped but not in the vault: a real decision, no guess.
    expect(byName.OPENAI_API_KEY?.suggestion).toBeUndefined();
    expect(result.every((k) => k.reason === "not_declared")).toBe(true);
  });

  it("blocks only visitor-facing rows that were never reviewed", () => {
    const result = findUndeclaredKeys({
      saved: [
        spec({ name: "PROMO_SECRET", description: AUTO_DETECTED_KEY_DESCRIPTION, credentialScope: "user" }),
        spec({ name: "LINKEDIN_LI_AT", credentialScope: "user", description: "" }),
        spec({ name: "OPENAI_API_KEY", description: "Writes drafts", credentialScope: "owner" }),
        spec({ name: "STRIPE_API_KEY", description: "", credentialScope: "owner" }),
        // Old auto-synced owner row: never shown to visitors, so not blocking.
        spec({ name: "RR_ATTENTION_API_KEY", description: AUTO_DETECTED_KEY_DESCRIPTION, credentialScope: "owner" }),
      ],
      detected: [],
      notKeys: [],
    });
    expect(result.map((k) => [k.name, k.reason])).toEqual([
      ["LINKEDIN_LI_AT", "missing_description"],
      ["PROMO_SECRET", "auto_detected"],
    ]);
  });

  it("skips names declared as not-a-key", () => {
    expect(
      findUndeclaredKeys({
        saved: [spec({ name: "TASK", description: AUTO_DETECTED_KEY_DESCRIPTION })],
        detected: [{ name: "TASK", source: "job-command", jobId: "j" }],
        notKeys: ["TASK"],
      }),
    ).toEqual([]);
  });
});

describe("publish never blocks on undeclared keys", () => {
  it("publishes undeclared credential keys as owner keys, skips parameters, leaves the file alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keys-fallback-"));
    fs.mkdirSync(path.join(dir, "apps", "app-1"), { recursive: true });
    fs.mkdirSync(path.join(dir, "Jobs", "job-1"), { recursive: true });
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data", "jobs.json"), JSON.stringify({ jobs: [{ id: "job-1", appIds: ["app-1"] }] }));
    fs.writeFileSync(
      path.join(dir, "Jobs", "job-1", "job.json"),
      JSON.stringify({ id: "job-1", command: 'python3 run.py "${TASK}" "${PROMO_SECRET}"', requiredKeys: ["SERPAPI_KEY"] }),
    );
    const { requirements } = await ensureAppRequirementsSyncedWithBackend(dir, "app-1");
    expect(requirements.map((spec) => [spec.name, spec.credentialScope])).toEqual([
      ["PROMO_SECRET", "owner"],
      ["SERPAPI_KEY", "owner"],
    ]);
    expect(readAppRequirements(dir, "app-1")).toEqual([]);
  });
});

describe("declared app keys end to end", () => {
  it("auto-sync no longer writes guessed keys", async () => {
    const dir = makeScreenshotApp();
    const { updated } = await ensureAppRequirementsSyncedWithBackend(dir, "app-1");
    expect(updated).toBe(false);
    expect(readAppRequirements(dir, "app-1")).toEqual([]);
  });

  it("blocks until every detected name is declared, then passes", async () => {
    const dir = makeScreenshotApp();
    const vault = new Set(["PROMO_SECRET"]);
    const before = await checkAppKeyDeclarations(dir, "app-1", { ownerVaultKeyNames: vault });
    expect(before.map((k) => k.name)).toEqual(["CAMPAIGN_JSON", "PROMO_SECRET", "TASK"]);

    upsertDeclaredAppKeys(
      dir,
      "app-1",
      [declaredKeyToSpec({ name: "PROMO_SECRET", purpose: "Signs promo codes", provider: "owner", required: true })],
      ["TASK", "CAMPAIGN_JSON"],
    );
    expect(await checkAppKeyDeclarations(dir, "app-1", { ownerVaultKeyNames: vault })).toEqual([]);
    expect(readAppNotKeys(dir, "app-1")).toEqual(["CAMPAIGN_JSON", "TASK"]);
    const saved = readAppRequirements(dir, "app-1");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: "PROMO_SECRET", credentialScope: "owner", description: "Signs promo codes" });
  });

  it("declaring a former not-key as a key removes it from notKeys", () => {
    const dir = makeScreenshotApp();
    upsertDeclaredAppKeys(dir, "app-1", [], ["TASK"]);
    upsertDeclaredAppKeys(dir, "app-1", [
      declaredKeyToSpec({ name: "TASK", purpose: "Actually a token", provider: "owner", required: true }),
    ]);
    expect(readAppNotKeys(dir, "app-1")).toEqual([]);
  });
});

describe("declaredKeyToSpec", () => {
  it("fills known-service metadata for visitors", () => {
    const out = declaredKeyToSpec({
      name: "OPENAI_API_KEY",
      purpose: "Writes your drafts with your own OpenAI account",
      provider: "user",
      required: true,
    });
    expect(out.service).toBe("OpenAI");
    expect(out.signupUrl).toContain("openai.com");
    expect(out.credentialScope).toBe("user");
    expect(out.description).toBe("Writes your drafts with your own OpenAI account");
  });
});
