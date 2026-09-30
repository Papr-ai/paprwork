import { describe, expect, it } from "vitest";
import {
  isUuidLikeName,
  isWikiRailExcluded,
  pickWikiLabel,
} from "../src/gateway/services/wikiGraphHelpers.js";
import {
  resolveWikiEntityDisplayName,
} from "../src/gateway/services/wikiGraphEntitySync.js";
import {
  clearAppsTitleCache,
  resolveMiniAppDisplayName,
  resolveProjectIdDisplayName,
  resolveUuidToDisplayName,
} from "../src/gateway/services/storage/codeIndexMetadata.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("wikiGraphHelpers", () => {
  it("pickWikiLabel prefers human names over UUIDs", () => {
    const label = pickWikiLabel(
      {
        id: "abc",
        name: "51cf27ba-3e9c-4eac-a1c1-93028bda6434",
        project_name: "Weekly War Room",
      },
      "project",
    );
    expect(label).toBe("Weekly War Room");
  });

  it("pickWikiLabel uses title for GTM persona types", () => {
    const label = pickWikiLabel(
      { id: "x", title: "VP Sales", name: "" },
      "person",
    );
    expect(label).toBe("VP Sales");
  });

  it("isWikiRailExcluded drops code file artifacts", () => {
    expect(
      isWikiRailExcluded(
        {
          id: "1",
          name: "App.tsx",
          source: "code_indexer",
          entity_type: "code_file",
          file_path: "/apps/foo/App.tsx",
        },
        "project",
      ),
    ).toBe(true);
  });

  it("isWikiRailExcluded keeps real projects", () => {
    expect(
      isWikiRailExcluded(
        {
          id: "1",
          name: "Revenue Reimagined",
          type: "project",
          description: "GTM audit",
        },
        "project",
      ),
    ).toBe(false);
  });

  it("isUuidLikeName detects UUID strings", () => {
    expect(isUuidLikeName("51cf27ba-3e9c-4eac-a1c1-93028bda6434")).toBe(true);
    expect(isUuidLikeName("Weekly War Room")).toBe(false);
  });

  it("resolveWikiEntityDisplayName resolves UUID project names", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-repair-"));
    const appId = "51cf27ba-3e9c-4eac-a1c1-93028bda6434";
    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "apps", appId), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "data", "apps.json"),
      JSON.stringify([{ id: appId, title: "Weekly War Room" }]),
      "utf-8",
    );
    process.env.PAPR_HOME = tmp;
    process.env.GATEWAY_MODE = "cloud_agent";
    clearAppsTitleCache();

    const resolved = resolveWikiEntityDisplayName(
      { id: appId, name: appId, type: "mini_app" },
      "project",
    );
    expect(resolved).toBe("Weekly War Room");

    delete process.env.PAPR_HOME;
    delete process.env.GATEWAY_MODE;
    clearAppsTitleCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("resolveUuidToDisplayName returns null for unknown UUIDs", () => {
    expect(resolveUuidToDisplayName("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(
      null,
    );
  });

  it("resolveProjectIdDisplayName prefers jobs.json name", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-repair-job-"));
    const jobId = "job-abc-123";
    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "data", "jobs.json"),
      JSON.stringify([{ id: jobId, name: "People Verify" }]),
      "utf-8",
    );
    process.env.PAPR_HOME = tmp;
    process.env.GATEWAY_MODE = "cloud_agent";
    clearAppsTitleCache();

    expect(resolveProjectIdDisplayName(jobId, "job")).toBe("People Verify");

    delete process.env.PAPR_HOME;
    delete process.env.GATEWAY_MODE;
    clearAppsTitleCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("codeIndexMetadata", () => {
  it("resolveMiniAppDisplayName reads apps.json then metadata.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-code-index-"));
    const appId = "51cf27ba-3e9c-4eac-a1c1-93028bda6434";
    const appPath = path.join(tmp, "apps", appId);
    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    fs.mkdirSync(appPath, { recursive: true });

    fs.writeFileSync(
      path.join(tmp, "data", "apps.json"),
      JSON.stringify([{ id: appId, title: "Weekly War Room" }]),
      "utf-8",
    );

    process.env.PAPR_HOME = tmp;
    process.env.GATEWAY_MODE = "cloud_agent";
    clearAppsTitleCache();

    expect(resolveMiniAppDisplayName(appId, appPath)).toBe("Weekly War Room");

    fs.writeFileSync(
      path.join(tmp, "data", "apps.json"),
      JSON.stringify([]),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(appPath, "metadata.json"),
      JSON.stringify({ title: "From metadata.json" }),
      "utf-8",
    );
    clearAppsTitleCache();

    expect(resolveMiniAppDisplayName(appId, appPath)).toBe("From metadata.json");

    delete process.env.PAPR_HOME;
    delete process.env.GATEWAY_MODE;
    clearAppsTitleCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
