/**
 * A file on disk must get a durable id even when cloud storage is down.
 *
 * Registering a file is how a caller stops holding a filesystem path. If an
 * outage in a service the file has never touched makes registration fail, the
 * caller keeps the path — and paths break on workspace migration, mean nothing
 * on another machine, and are empty for every visitor to a published app.
 * That is the failure this whole subsystem exists to prevent, so an unrelated
 * 500 must not reintroduce it.
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
  hashFile: vi.fn(async () => "sha-of-recording"),
  uploadResumable: vi.fn(async () => undefined),
}));

const { addFile, ensureSchema } = await import(
  "../../../src/gateway/services/appFiles/AppFilesService.js"
);
const { resolveLocation } = await import(
  "../../../src/gateway/services/appFiles/appFilesSchema.js"
);

/** In-memory stand-in for the app's SQLite, matching the FilesDb surface. */
function memoryDb() {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    async exec() {},
    async run(sql: string, params: unknown[] = []) {
      if (sql.includes("INSERT INTO app_files")) {
        const [
          id,
          app_id,
          object_key,
          sha256,
          size_bytes,
          mime,
          file_name,
          scope,
          local_path,
        ] = params as string[];
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
          visibility: "inherit",
        });
      }
      return { changes: 1 };
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.includes("FROM app_files WHERE object_key")) {
        return rows.filter((r) => r.object_key === params[0]) as T[];
      }
      if (sql.includes("app_file_hashes")) return [];
      return [] as T[];
    },
  };
}

describe("addFile — cloud outage fallback", () => {
  beforeEach(() => {
    requestUploadTicket.mockReset();
    commitUpload.mockReset();
  });

  it("still returns an id when the ticket endpoint fails", async () => {
    requestUploadTicket.mockRejectedValue(
      Object.assign(new Error("App Files /v1/files/tickets failed (500)"), {
        status: 500,
      }),
    );
    const db = memoryDb();
    await ensureSchema(db);

    const result = await addFile(db, {
      appId: "app-1",
      filePath: import.meta.url.replace("file://", ""),
    });

    expect(result.id).toBeTruthy();
    expect(result.verified).toBe(false);
  });

  it("keeps the file readable from disk while the upload is pending", async () => {
    requestUploadTicket.mockRejectedValue(new Error("cloud down"));
    const db = memoryDb();
    const localFile = import.meta.url.replace("file://", "");

    await addFile(db, { appId: "app-1", filePath: localFile });

    const row = db.rows[0] as { local_path: string; upload_state: string };
    expect(row.upload_state).toBe("pending");
    // The point of the fallback: the app can still play the recording today.
    expect(resolveLocation(row as never)).toEqual({
      kind: "local",
      path: localFile,
    });
  });

  it("reuses one row when the same file is registered twice", async () => {
    requestUploadTicket.mockRejectedValue(new Error("cloud down"));
    const db = memoryDb();
    const localFile = import.meta.url.replace("file://", "");

    const first = await addFile(db, { appId: "app-1", filePath: localFile });
    const second = await addFile(db, { appId: "app-1", filePath: localFile });

    // Content-addressed, so a retried job does not accumulate duplicates.
    expect(db.rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });

  it("does not fall back when the cloud is reachable", async () => {
    requestUploadTicket.mockResolvedValue({
      object_key: "apps/app-1/sha-of-recording",
      upload_url: null,
      already_exists: true,
      scope: "app",
      max_bytes: 1_000_000_000,
    });
    const db = memoryDb();

    const result = await addFile(db, {
      appId: "app-1",
      filePath: import.meta.url.replace("file://", ""),
    });

    expect(result.deduped).toBe(true);
    expect(result.verified).toBe(true);
  });
});
