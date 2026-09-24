import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergeBackendKeysIntoRequirements,
  parseRequirementItemsLoose,
  readAppRequirements,
  readLinkedJobKeyNames,
} from "../src/gateway/services/cloudAppRequirements.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("cloudAppRequirements backend key sync", () => {
  it("merges backend manifest keys as owner-scoped server requirements", () => {
    const merged = mergeBackendKeysIntoRequirements(
      [],
      ["RR_ATTENTION_API_KEY", "NEON_DB_URL"],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]?.name).toBe("RR_ATTENTION_API_KEY");
    expect(merged[0]?.credentialScope).toBe("owner");
    expect(merged[0]?.clientAccess).toBe("server");
    expect(merged[1]?.name).toBe("NEON_DB_URL");
  });

  it("does not duplicate existing requirements", () => {
    const existing = mergeBackendKeysIntoRequirements([], ["RR_ATTENTION_API_KEY"]);
    const merged = mergeBackendKeysIntoRequirements(existing, [
      "RR_ATTENTION_API_KEY",
    ]);
    expect(merged).toHaveLength(1);
  });

  it("readAppRequirements returns empty when file missing", () => {
    expect(readAppRequirements("/nonexistent/papr", "app-id")).toEqual([]);
  });

  it("readLinkedJobKeyNames returns empty when app has no linked jobs", () => {
    expect(readLinkedJobKeyNames("/nonexistent/papr", "app-id")).toEqual([]);
  });

  it("parseRequirementItemsLoose accepts name-only objects (missing service)", () => {
    const specs = parseRequirementItemsLoose([
      {
        name: "RR_ATTENTION_API_KEY",
        credentialScope: "owner",
        description: "Attention API",
      },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe("RR_ATTENTION_API_KEY");
    expect(specs[0]?.service).toBe("Rr Attention");
    expect(specs[0]?.credentialScope).toBe("owner");
  });

  it("readAppRequirements reads name-only requirements.json from disk", () => {
    const paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-req-read-"));
    tempDirs.push(paprDir);
    const appId = "app-req-test";
    fs.mkdirSync(path.join(paprDir, "apps", appId), { recursive: true });
    fs.writeFileSync(
      path.join(paprDir, "apps", appId, "requirements.json"),
      JSON.stringify({
        schemaVersion: "1.0.0",
        requirements: [{ name: "RR_ATTENTION_API_KEY", credentialScope: "owner" }],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(readAppRequirements(paprDir, appId).map((s) => s.name)).toEqual([
      "RR_ATTENTION_API_KEY",
    ]);
  });
});
