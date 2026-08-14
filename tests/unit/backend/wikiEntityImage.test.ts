import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `resolveEntityImage` resolves against `getEntitiesDir()`, which derives from
 * `getPaprWorkspaceDir()`. On a desktop install that reads the real
 * `~/Papr/.active-workspace.json` pointer, which takes precedence over PAPR_HOME —
 * so stub the workspace resolver directly and point it at a fixture tree.
 */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "papr-wiki-img-"));

vi.mock("../../../src/core/utils/paprRoot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/utils/paprRoot")>();
  return {
    ...actual,
    getPaprWorkspaceDir: () => path.join(tmpHome, "workspace"),
    getPaprRoot: () => tmpHome,
  };
});

const entitiesDir = path.join(tmpHome, "workspace", "entities");
const companiesDir = path.join(entitiesDir, "companies");
const assetsDir = path.join(entitiesDir, "assets", "companies");

// 1x1 transparent PNG.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let resolveEntityImage: (raw: unknown, entityDir: string) => string | null;

beforeAll(async () => {
  process.env.PAPR_HOME = tmpHome;
  fs.mkdirSync(companiesDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "acme.png"), PNG_1PX);
  fs.writeFileSync(path.join(assetsDir, "acme-photo.jpg"), PNG_1PX);
  fs.writeFileSync(path.join(assetsDir, "notes.txt"), "not an image");
  fs.writeFileSync(path.join(tmpHome, "outside-secret.png"), PNG_1PX);

  ({ resolveEntityImage } = await import(
    "../../../src/gateway/services/KnowledgeGraphWikiService"
  ));
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("resolveEntityImage", () => {
  it("inlines a relative asset path as a base64 data URI", () => {
    const result = resolveEntityImage("../assets/companies/acme.png", companiesDir);
    expect(result).toBeTruthy();
    expect(result).toMatch(/^data:image\/png;base64,/);
    // Round-trips to the original bytes.
    const b64 = result!.split(",")[1];
    expect(Buffer.from(b64, "base64").equals(PNG_1PX)).toBe(true);
  });

  it("maps .jpg to image/jpeg", () => {
    const result = resolveEntityImage("../assets/companies/acme-photo.jpg", companiesDir);
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("passes through absolute http(s) URLs untouched", () => {
    const url = "https://cdn.example.com/logo.png";
    expect(resolveEntityImage(url, companiesDir)).toBe(url);
  });

  it("passes through existing data URIs untouched", () => {
    const uri = "data:image/png;base64,AAAA";
    expect(resolveEntityImage(uri, companiesDir)).toBe(uri);
  });

  it("refuses paths that escape the entities directory", () => {
    // ../../outside-secret.png from companies/ lands in the workspace root.
    expect(resolveEntityImage("../../outside-secret.png", companiesDir)).toBeNull();
    expect(resolveEntityImage("/etc/passwd", companiesDir)).toBeNull();
  });

  it("returns null for missing files, non-images, and empty values", () => {
    expect(resolveEntityImage("../assets/companies/nope.png", companiesDir)).toBeNull();
    expect(resolveEntityImage("../assets/companies/notes.txt", companiesDir)).toBeNull();
    expect(resolveEntityImage("", companiesDir)).toBeNull();
    expect(resolveEntityImage(undefined, companiesDir)).toBeNull();
    expect(resolveEntityImage(42, companiesDir)).toBeNull();
  });
});
