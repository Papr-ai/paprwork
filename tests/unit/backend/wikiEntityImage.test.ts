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
  const actual =
    await importOriginal<typeof import("../../../src/core/utils/paprRoot")>();
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

  ({ resolveEntityImage } =
    await import("../../../src/gateway/services/KnowledgeGraphWikiService"));
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("resolveEntityImage", () => {
  it("inlines a relative asset path as a base64 data URI", () => {
    const result = resolveEntityImage(
      "../assets/companies/acme.png",
      companiesDir,
    );
    expect(result).toBeTruthy();
    expect(result).toMatch(/^data:image\/png;base64,/);
    // Round-trips to the original bytes.
    const b64 = result!.split(",")[1];
    expect(Buffer.from(b64, "base64").equals(PNG_1PX)).toBe(true);
  });

  it("maps .jpg to image/jpeg", () => {
    const result = resolveEntityImage(
      "../assets/companies/acme-photo.jpg",
      companiesDir,
    );
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
    expect(
      resolveEntityImage("../../outside-secret.png", companiesDir),
    ).toBeNull();
    expect(resolveEntityImage("/etc/passwd", companiesDir)).toBeNull();
  });

  it("returns null for missing files, non-images, and empty values", () => {
    expect(
      resolveEntityImage("../assets/companies/nope.png", companiesDir),
    ).toBeNull();
    expect(
      resolveEntityImage("../assets/companies/notes.txt", companiesDir),
    ).toBeNull();
    expect(resolveEntityImage("", companiesDir)).toBeNull();
    expect(resolveEntityImage(undefined, companiesDir)).toBeNull();
    expect(resolveEntityImage(42, companiesDir)).toBeNull();
  });
});

describe("updateWikiEntityMedia", () => {
  let updateWikiEntityMedia: typeof import("../../../src/gateway/services/KnowledgeGraphWikiService").updateWikiEntityMedia;
  const companyFile = path.join(companiesDir, "acme.md");
  const personDir = path.join(entitiesDir, "people");

  beforeAll(async () => {
    fs.mkdirSync(personDir, { recursive: true });
    fs.writeFileSync(companyFile, "---\nid: acme\nname: Acme\n---\n# Acme\n");
    fs.writeFileSync(
      path.join(personDir, "ada.md"),
      "---\nid: ada\nname: Ada\n---\n# Ada\n",
    );
    ({ updateWikiEntityMedia } =
      await import("../../../src/gateway/services/KnowledgeGraphWikiService"));
  });

  it("stores a safe SVG logo and updates frontmatter", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>',
    );
    const dataUrl = `data:image/svg+xml;base64,${svg.toString("base64")}`;
    const result = await updateWikiEntityMedia({
      type: "company",
      id: "company/acme",
      kind: "image",
      dataUrl,
    });
    expect(result.path).toBe("../assets/companies/acme.svg");
    expect(fs.readFileSync(companyFile, "utf8")).toContain(
      "image: ../assets/companies/acme.svg",
    );
  });

  it("normalizes a hero to bounded WebP and can remove it", async () => {
    const dataUrl = `data:image/png;base64,${PNG_1PX.toString("base64")}`;
    const added = await updateWikiEntityMedia({
      type: "company",
      id: "acme",
      kind: "hero_image",
      dataUrl,
    });
    expect(added.path).toBe("../assets/companies/acme-hero.webp");
    const heroPath = path.join(assetsDir, "acme-hero.webp");
    expect(fs.existsSync(heroPath)).toBe(true);
    expect(fs.statSync(heroPath).size).toBeLessThanOrEqual(1024 * 1024);
    expect(fs.readFileSync(companyFile, "utf8")).toContain(
      "hero_image: ../assets/companies/acme-hero.webp",
    );
    await updateWikiEntityMedia({
      type: "company",
      id: "acme",
      kind: "hero_image",
      dataUrl: null,
    });
    expect(fs.existsSync(heroPath)).toBe(false);
    expect(fs.readFileSync(companyFile, "utf8")).not.toContain("hero_image:");
  });

  it("accepts plural type aliases", async () => {
    await expect(
      updateWikiEntityMedia({
        type: "people",
        id: "ada",
        kind: "hero_image",
        dataUrl: null,
      }),
    ).resolves.toEqual({ path: null });
  });

  it("rejects unsafe SVG and unsupported entity types", async () => {
    const unsafe = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    await expect(
      updateWikiEntityMedia({
        type: "company",
        id: "acme",
        kind: "image",
        dataUrl: `data:image/svg+xml;base64,${unsafe.toString("base64")}`,
      }),
    ).rejects.toThrow("Unsafe SVG");
    await expect(
      updateWikiEntityMedia({
        type: "project",
        id: "demo",
        kind: "image",
        dataUrl: null,
      }),
    ).rejects.toThrow("companies and people");
  });
});
