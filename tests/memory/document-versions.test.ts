import { beforeEach, describe, expect, test, vi, afterEach } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { DocumentService } from "../../src/gateway/services/DocumentService.js";
import {
  buildVersionId,
  isSafeVersionId,
  parseVersionId,
  sanitizeVersionReason,
} from "../../src/gateway/services/documentVersionId.js";
import { useIsolatedPaprWorkspace } from "../setup/isolatedWorkspace.js";

describe("document version ids", () => {
  test("round-trip timestamp and multi-word reason", () => {
    const id = buildVersionId(new Date("2026-10-30T16:10:06.123Z"), "v2 after review");
    expect(id).toBe("2026-10-30T16-10-06-123Z_v2-after-review");
    expect(parseVersionId(id)).toEqual({
      timestamp: "2026-10-30T16:10:06.123Z",
      reason: "v2-after-review",
    });
  });

  test("keeps underscores inside the reason", () => {
    expect(parseVersionId("2026-01-02T03-04-05-006Z_before_restore").reason).toBe(
      "before_restore",
    );
  });

  test("unparseable ids report no timestamp instead of 'now'", () => {
    expect(parseVersionId("hand-made_v1").timestamp).toBeNull();
  });

  test("sanitises labels and blocks traversal", () => {
    expect(sanitizeVersionReason("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeVersionReason("   ")).toBe("save");
    expect(isSafeVersionId("../x")).toBe(false);
    expect(isSafeVersionId("2026-01-02T03-04-05-006Z_v2")).toBe(true);
  });
});

describe("DocumentService versions", () => {
  useIsolatedPaprWorkspace("document-versions");
  let service: DocumentService;

  beforeEach(async () => {
    service = new DocumentService();
    await service.initialize();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("reports the real label and time (old parser showed 'save' / now)", async () => {
    const doc = await service.createDocument("Arch", "v1 body");
    await service.saveVersion(doc.id, "v1 body", "v1");
    const [v] = await service.getVersionHistory(doc.id);
    expect(v.reason).toBe("v1");
    expect(v.named).toBe(true);
    expect(Date.now() - new Date(v.timestamp).getTime()).toBeLessThan(5000);
  });

  test("auto-saves coalesce within the window; named versions are kept", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T10:00:00.000Z"));
    const doc = await service.createDocument("Doc", "a");
    await service.saveVersion(doc.id, "a", "v1");
    vi.setSystemTime(new Date("2026-10-30T10:00:01.000Z"));
    await service.saveVersion(doc.id, "ab", "auto-save");
    vi.setSystemTime(new Date("2026-10-30T10:00:02.000Z"));
    await service.saveVersion(doc.id, "abc", "auto-save");
    vi.setSystemTime(new Date("2026-10-30T10:30:00.000Z"));
    await service.saveVersion(doc.id, "abcd", "auto-save");

    const versions = await service.getVersionHistory(doc.id);
    expect(versions.map((v) => v.reason)).toEqual(["auto-save", "auto-save", "v1"]);
    const middle = await service.getVersion(doc.id, versions[1].versionId);
    expect(middle?.content).toBe("abc");
  });

  test("naming unchanged content after an auto-save still creates the named version", async () => {
    const doc = await service.createDocument("Doc", "same");
    await service.saveVersion(doc.id, "same", "auto-save");
    const id = await service.saveVersion(doc.id, "same", "v2");
    expect(parseVersionId(id).reason).toBe("v2");
    // …but saving the same unnamed content again is still a no-op
    const again = await service.saveVersion(doc.id, "same", "auto-save");
    expect(again).toBe(id);
  });

  test("restore keeps a before-restore snapshot", async () => {
    const doc = await service.createDocument("Doc", "old");
    const v1 = await service.saveVersion(doc.id, "old", "v1");
    await service.updateDocument(doc.id, { content: "new" });
    const restored = await service.restoreVersion(doc.id, v1);
    expect(restored?.content).toBe("old");
    const reasons = (await service.getVersionHistory(doc.id)).map((v) => v.reason);
    expect(reasons).toContain("before-restore");
  });

  test("hand-made snapshot files fall back to file mtime", async () => {
    const doc = await service.createDocument("Doc", "x");
    const dir = path.join(path.dirname(doc.filePath), "versions");
    await fs.writeFile(path.join(dir, "draft_v0.md"), "x0", "utf-8");
    const [v] = await service.getVersionHistory(doc.id);
    expect(v.versionId).toBe("draft_v0");
    expect(new Date(v.timestamp).getTime()).toBeGreaterThan(0);
  });

  test("rejects path traversal in getVersion", async () => {
    const doc = await service.createDocument("Doc", "x");
    expect(await service.getVersion(doc.id, "../meta")).toBeNull();
  });
});
