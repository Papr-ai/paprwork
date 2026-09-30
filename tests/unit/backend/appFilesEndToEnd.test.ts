/**
 * End-to-end: a real Express gateway, a real SQLite database, a fake GCS.
 *
 * The unit tests prove each piece. This proves they connect — a file goes in
 * through the same routes a mini-app calls, the bytes land in storage, and the
 * row comes back verified and resolvable.
 *
 * Only the memory server and GCS are faked; everything between the HTTP route
 * and the database is the real code path.
 */

import Database from "better-sqlite3";
import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const CHUNK = 8 * 1024 * 1024;
/** Two chunks plus change, so the multi-chunk path really runs. */
const TOTAL = CHUNK * 2 + 1024;
const OBJECT_KEY = "namespaces/ns-1/apps/app-1/files/" + "a".repeat(64);
const APP_ID = "11111111-2222-4333-8444-555555555555";

let server: Server;
let baseUrl = "";
let raw: Database.Database;
/** Bytes the fake GCS has committed — the proof bytes actually moved. */
let gcsCommitted = 0;

beforeAll(async () => {
  raw = new Database(":memory:");

  // Fake the memory server: mint a ticket, verify a commit. No credentials,
  // no network — the trust boundary is tested in Phase 1.
  vi.doMock("../../../src/gateway/services/appFiles/appFilesClient.js", () => ({
    requestUploadTicket: async () => ({
      object_key: OBJECT_KEY,
      upload_url: `${baseUrl}/__gcs__/session`,
      already_exists: false,
      scope: "app",
      max_bytes: 100 * 1024 ** 3,
    }),
    commitUpload: async (_a: string, _k: string, size: number) => ({
      verified: gcsCommitted === size,
      object_key: OBJECT_KEY,
      size_bytes: gcsCommitted,
    }),
    createReadUrl: async () => ({
      url: "https://signed.example/obj?sig=abc",
      expiresInSeconds: 900,
    }),
    deleteObject: async () => true,
    appUsage: async () => ({ bytes: 0 }),
  }));

  const { registerAppFilesRoutes } = await import(
    "../../../src/gateway/services/appFiles/appFilesRoutes.js"
  );

  const app = express();
  app.use(express.json());

  // Fake GCS resumable endpoint, honouring Content-Range like the real thing.
  app.put("/__gcs__/session", (req, res) => {
    const range = req.headers["content-range"] as string;
    if (range?.startsWith("bytes */")) {
      if (gcsCommitted === 0) return void res.status(308).end();
      return void res
        .setHeader("Range", `bytes=0-${gcsCommitted - 1}`)
        .status(308)
        .end();
    }
    const m = /bytes (\d+)-(\d+)\//.exec(range ?? "");
    gcsCommitted = Number(m?.[2]) + 1;
    if (gcsCommitted >= TOTAL) return void res.status(200).end();
    res.setHeader("Range", `bytes=0-${gcsCommitted - 1}`).status(308).end();
  });

  // Wire the routes to the real SQLite database.
  registerAppFilesRoutes(app, {
    resolveSource: async () => ({}),
    dbQuery: async (_app, _src, sql, params = []) => ({
      rows: raw.prepare(sql).all(...(params as never[])) as unknown[],
    }),
    dbWrite: async (_app, _src, sql, params = []) => ({
      changes: raw.prepare(sql).run(...(params as never[])).changes,
    }),
    dbExec: async (_app, _src, sql) => {
      raw.exec(sql);
    },
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  raw.close();
  vi.doUnmock("../../../src/gateway/services/appFiles/appFilesClient.js");
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("App Files end-to-end", () => {
  let fileId = "";

  it("mints a ticket and records the session for resume", async () => {
    const res = await post("/api/files/ticket", {
      appId: APP_ID,
      fileName: "recording.mp4",
      sizeBytes: TOTAL,
      mime: "video/mp4",
      fingerprint: "a".repeat(64),
    });
    expect(res.status).toBe(200);

    const ticket = (await res.json()) as { id: string; uploadUrl: string };
    fileId = ticket.id;
    expect(ticket.uploadUrl).toContain("/__gcs__/session");

    // The session URI must be on the row before any byte moves — this is what
    // turns a dead laptop at 9 GB into a resume rather than a restart.
    const row = raw
      .prepare(`SELECT upload_session_uri, upload_state FROM app_files WHERE id = ?`)
      .get(fileId) as { upload_session_uri: string; upload_state: string };
    expect(row.upload_session_uri).toContain("/__gcs__/session");
    expect(row.upload_state).toBe("uploading");
  });

  it("uploads the bytes straight to storage, chunked", async () => {
    // Exactly what the browser SDK does: slice and PUT with Content-Range.
    let offset = 0;
    while (offset < TOTAL) {
      const end = Math.min(offset + CHUNK, TOTAL);
      const res = await fetch(`${baseUrl}/__gcs__/session`, {
        method: "PUT",
        body: new Uint8Array(end - offset),
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${TOTAL}` },
      });
      expect([200, 308]).toContain(res.status);
      offset = end;
    }
    expect(gcsCommitted).toBe(TOTAL);
  });

  it("verifies the upload server-side and marks the row verified", async () => {
    const res = await post("/api/files/commit", {
      appId: APP_ID,
      id: fileId,
      objectKey: OBJECT_KEY,
      sizeBytes: TOTAL,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).verified).toBe(true);

    const row = raw
      .prepare(`SELECT upload_state, upload_session_uri FROM app_files WHERE id = ?`)
      .get(fileId) as { upload_state: string; upload_session_uri: string | null };
    expect(row.upload_state).toBe("verified");
    // Spent session cleared, so nothing tries to resume a finished object.
    expect(row.upload_session_uri).toBeNull();
  });

  it("lists the file", async () => {
    const res = await fetch(`${baseUrl}/api/files?appId=${APP_ID}`);
    const body = (await res.json()) as { files: { id: string }[] };
    expect(body.files.map((f) => f.id)).toContain(fileId);
  });

  it("resolves the file to a loadable URL", async () => {
    const res = await post("/api/files/url", { appId: APP_ID, id: fileId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string; location: { kind: string } };
    expect(body.location.kind).toBe("cloud");
    expect(body.url).toContain("signed.example");
  });

  it("removes the file", async () => {
    const res = await post("/api/files/delete", { appId: APP_ID, id: fileId });
    expect((await res.json()).deleted).toBe(true);
    const rows = raw.prepare(`SELECT id FROM app_files WHERE id = ?`).all(fileId);
    expect(rows).toHaveLength(0);
  });
});
