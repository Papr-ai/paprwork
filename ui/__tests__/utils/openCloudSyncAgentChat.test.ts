import { describe, expect, it } from "vitest";
import {
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
