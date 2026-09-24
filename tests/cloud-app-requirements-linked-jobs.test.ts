import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readEffectiveAppRequirements,
  readLinkedJobCatalogKeyRefs,
  readLinkedJobKeyNames,
  readLinkedJobKeysMissingFromSavedRequirements,
  writeAppRequirements,
} from "../src/gateway/services/cloudAppRequirements.js";
import { checkLinkedJobPublishCatalogGaps } from "../src/gateway/utils/miniAppPublishCatalogLint.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makePaprDir(appId = "app-1", jobId = "job-sync"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-req-test-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "apps", appId), { recursive: true });
  fs.mkdirSync(path.join(dir, "Jobs", jobId), { recursive: true });
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data", "jobs.json"),
    JSON.stringify({
      jobs: [{ id: jobId, name: "Sync", appIds: [appId] }],
    }),
  );
  return dir;
}

describe("readLinkedJobKeyNames", () => {
  it("includes job.json requiredKeys without ${} in command", () => {
    const paprDir = makePaprDir();
    fs.writeFileSync(
      path.join(paprDir, "Jobs", "job-sync", "job.json"),
      JSON.stringify({
        id: "job-sync",
        command: "python3 code/interview_pull.py",
        requiredKeys: ["RR_ATTENTION_API_KEY"],
      }),
    );

    expect(readLinkedJobKeyNames(paprDir, "app-1")).toEqual([
      "RR_ATTENTION_API_KEY",
    ]);
    const refs = readLinkedJobCatalogKeyRefs(paprDir, "app-1");
    expect(refs).toEqual([
      {
        jobId: "job-sync",
        keyName: "RR_ATTENTION_API_KEY",
        source: "requiredKeys",
      },
    ]);
  });

  it("merges command placeholders and requiredKeys", () => {
    const paprDir = makePaprDir();
    fs.writeFileSync(
      path.join(paprDir, "Jobs", "job-sync", "job.json"),
      JSON.stringify({
        id: "job-sync",
        command: 'python3 main.py --db "${NEON_DB_URL}"',
        requiredKeys: ["RR_ATTENTION_API_KEY"],
      }),
    );

    expect(readLinkedJobKeyNames(paprDir, "app-1")).toEqual([
      "NEON_DB_URL",
      "RR_ATTENTION_API_KEY",
    ]);
  });

  it("readEffectiveAppRequirements includes linked job requiredKeys", async () => {
    const paprDir = makePaprDir();
    fs.writeFileSync(
      path.join(paprDir, "Jobs", "job-sync", "job.json"),
      JSON.stringify({
        id: "job-sync",
        command: "python3 code/main.py",
        requiredKeys: ["RR_ATTENTION_API_KEY"],
      }),
    );

    const effective = await readEffectiveAppRequirements(paprDir, "app-1");
    expect(effective.map((spec) => spec.name)).toContain("RR_ATTENTION_API_KEY");
  });

  it("flags keys missing from saved requirements.json", () => {
    const paprDir = makePaprDir();
    fs.writeFileSync(
      path.join(paprDir, "Jobs", "job-sync", "job.json"),
      JSON.stringify({
        id: "job-sync",
        command: "python3 code/main.py",
        requiredKeys: ["RR_ATTENTION_API_KEY"],
      }),
    );

    const missing = readLinkedJobKeysMissingFromSavedRequirements(
      paprDir,
      "app-1",
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.keyName).toBe("RR_ATTENTION_API_KEY");

    writeAppRequirements(paprDir, "app-1", [
      {
        name: "RR_ATTENTION_API_KEY",
        service: "Rr Attention",
        category: "other",
        description: "test",
        required: true,
        credentialScope: "owner",
        clientAccess: "server",
      },
    ]);
    expect(
      readLinkedJobKeysMissingFromSavedRequirements(paprDir, "app-1"),
    ).toEqual([]);
  });

  it("validate_app lint surfaces catalog gaps", () => {
    const paprDir = makePaprDir();
    fs.writeFileSync(
      path.join(paprDir, "Jobs", "job-sync", "job.json"),
      JSON.stringify({
        id: "job-sync",
        command: "python3 code/main.py",
        requiredKeys: ["RR_ATTENTION_API_KEY"],
      }),
    );

    const issues = checkLinkedJobPublishCatalogGaps(paprDir, "app-1");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("publish-catalog-linked-job-key");
    expect(issues[0]?.message).toContain("requirements.json");
    expect(issues[0]?.message).toContain("papr-cloud-dependencies.json");
  });
});
