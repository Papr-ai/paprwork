/**
 * Files registered during a cloud outage must eventually reach the cloud.
 *
 * `addFileLocally` writes a `pending` row so a file on disk stays registerable
 * while storage is down. Without a retry that is a trap rather than a
 * fallback: the app keeps working off the local copy, the durability everyone
 * assumes they have never arrives, and the gap only surfaces on the day the
 * local copy is gone.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const requestUploadTicket = vi.fn();
const commitUpload = vi.fn();

vi.mock("../../../src/gateway/services/appFiles/appFilesClient.js", () => ({
  requestUploadTicket: (...args: unknown[]) => requestUploadTicket(...args),
  commitUpload: (...args: unknown[]) => commitUpload(...args),
  createReadUrl: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock("../../../src/gateway/services/appFiles/resumableUploader.js", () => ({
  hashFile: vi.fn(async () => "sha-recording"),
  uploadResumable: vi.fn(async () => undefined),
}));

const { addFile, retryPendingUploads } = await import(
  "../../../src/gateway/services/appFiles/AppFilesService.js"
);

const THIS_FILE = import.meta.url.replace("file://", "");

/** In-memory stand-in for the app's SQLite, matching the FilesDb surface. */
function memoryDb() {
  const rows: Record<string, any>[] = [];
  return {
    rows,
    async exec() {},
    async run(sql: string, params: unknown[] = []) {
      if (sql.startsWith("DELETE FROM app_files")) {
        const index = rows.findIndex((r) => r.object_key === params[0]);
        if (index >= 0) rows.splice(index, 1);
        return { changes: 1 };
      }
      if (sql.includes("INSERT INTO app_files")) {
        const [id, app_id, object_key, sha256, size_bytes, mime, file_name, scope, local_path] =
          params as string[];
        const existing = rows.find((r) => r.object_key === object_key);
        if (existing) {
          existing.local_path = local_path;
          return { changes: 1 };
        }
        rows.push({
          id,
          app_id,
          object_key,
          sha256,
          size_bytes,
          mime,
          file_name,
          scope,
          local_path,
          upload_state: sql.includes("'pending'") ? "pending" : "uploading",
          created_at: Date.now(),
        });
      }
      return { changes: 1 };
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.includes("upload_state = 'pending'")) {
        return rows.filter(
          (r) => r.app_id === params[0] && r.upload_state === "pending" && r.local_path,
        ) as T[];
      }
      if (sql.includes("FROM app_files WHERE object_key")) {
        return rows.filter((r) => r.object_key === params[0]) as T[];
      }
      return [] as T[];
    },
  };
}

describe("retryPendingUploads", () => {
  beforeEach(() => {
    requestUploadTicket.mockReset();
    commitUpload.mockReset();
  });

  it("uploads a pending file once the cloud comes back", async () => {
    requestUploadTicket.mockRejectedValueOnce(new Error("cloud down"));
    const db = memoryDb();
    await addFile(db, { appId: "app-1", filePath: THIS_FILE });
    expect(db.rows[0].upload_state).toBe("pending");

    requestUploadTicket.mockResolvedValue({
      object_key: "apps/app-1/sha-recording",
      upload_url: null,
      already_exists: true,
      scope: "app",
      max_bytes: 1e9,
    });

    const result = await retryPendingUploads(db, "app-1");

    expect(result.uploaded).toBe(1);
    // The placeholder row is replaced, not left alongside the real one —
    // otherwise the same file would be listed twice.
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].object_key).toBe("apps/app-1/sha-recording");
  });

  it("leaves the row alone while the cloud is still down", async () => {
    requestUploadTicket.mockRejectedValue(new Error("cloud down"));
    const db = memoryDb();
    await addFile(db, { appId: "app-1", filePath: THIS_FILE });

    const result = await retryPendingUploads(db, "app-1");

    // Retrying must be free of side effects, since it will run again.
    expect(result.uploaded).toBe(0);
    expect(result.stillPending).toBe(1);
    expect(db.rows[0].local_path).toBe(THIS_FILE);
  });

  it("skips rows whose local copy has disappeared", async () => {
    requestUploadTicket.mockRejectedValueOnce(new Error("cloud down"));
    const db = memoryDb();
    await addFile(db, { appId: "app-1", filePath: THIS_FILE });
    db.rows[0].local_path = "/tmp/definitely-not-here.wav";

    const result = await retryPendingUploads(db, "app-1");

    // No bytes anywhere, so retrying forever would just log noise.
    expect(result).toEqual({ uploaded: 0, stillPending: 0, skipped: 1 });
  });

  it("does nothing when there is nothing pending", async () => {
    const db = memoryDb();
    expect(await retryPendingUploads(db, "app-1")).toEqual({
      uploaded: 0,
      stillPending: 0,
      skipped: 0,
    });
  });
});
