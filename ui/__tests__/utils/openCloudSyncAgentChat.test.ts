import { describe, expect, it } from "vitest";
import {
  buildOversizedFilesAgentPrompt,
  buildSchemaDriftAgentPrompt,
  buildUploadFailureAgentPrompt,
} from "../../utils/openCloudSyncAgentChat";

describe("buildSchemaDriftAgentPrompt", () => {
  it("includes Plan A migration workflow and syncMode for linked DBs", () => {
    const prompt = buildSchemaDriftAgentPrompt({
      appId: "91d94d77-dace-4746-8be4-2f7e385c6944",
      databases: [
        {
          alias: "gtm",
          syncMode: "legacy",
          detail: "Local schema changed — click Upload now to update Turso.",
        },
      ],
      publishDetail: "gtm: local schema changed",
    });

    expect(prompt).toContain("91d94d77-dace-4746-8be4-2f7e385c6944");
    expect(prompt).toContain("gtm — legacy");
    expect(prompt).toContain("Upload now");
    expect(prompt).toContain("push_cloud_sync({ appId })");
    expect(prompt).toContain("papr_db_apply_migration");
    expect(prompt).toContain("bootstrap_remote");
    expect(prompt).toContain("never delete_database/recreate");
    expect(prompt).not.toContain("schema drift heal");
  });

  it("flags migration conflict and cutover blocked on replica DBs", () => {
    const prompt = buildSchemaDriftAgentPrompt({
      databases: [
        {
          alias: "metrics",
          syncMode: "replica",
          migrationConflict: true,
          cutoverBlocked: true,
          cutoverBlockReason: "remote ahead",
        },
      ],
    });

    expect(prompt).toContain("metrics — replica");
    expect(prompt).toContain("migration conflict");
    expect(prompt).toContain("cutover blocked: remote ahead");
    expect(prompt).toContain("repair_cloud_sync");
  });
});

describe("buildOversizedFilesAgentPrompt", () => {
  it("includes app id, skipped file details, and App Files workflow", () => {
    const prompt = buildOversizedFilesAgentPrompt({
      appId: "9e70c06b-ac30-4c95-bfe2-adc1daecbeb0",
      count: 1,
      message:
        "1 file(s) in this app will not sync to the web:\n  • apps/9e70c06b/data.db (never tracked by git — use App Files)",
    });

    expect(prompt).toContain("9e70c06b-ac30-4c95-bfe2-adc1daecbeb0");
    expect(prompt).toContain("1 file(s) skipped");
    expect(prompt).toContain("data.db");
    expect(prompt).toContain("get_cloud_sync_status");
    expect(prompt).toContain("App Files");
  });
});

describe("buildUploadFailureAgentPrompt", () => {
  it("includes Upload-now cutover guardrails for legacy DBs", () => {
    const prompt = buildUploadFailureAgentPrompt({
      appId: "app-1",
      error: "Cutover blocked: schema drift",
      databases: [{ alias: "gtm", syncMode: "legacy" }],
    });

    expect(prompt).toContain("Upload now");
    expect(prompt).toContain("push_cloud_sync({ appId })");
    expect(prompt).toContain("never delete/recreate");
    expect(prompt).toContain("repair_cloud_sync");
  });
});
