/**
 * Published-app uploads go through a pluggable transport so the cloud host can
 * mint/verify under the APP's sharing rules (no visitor key). These tests pin
 * that the transport — not the caller's key — is what createBrowserTicket and
 * commitBrowserUpload use, and that the row lifecycle is unchanged.
 */

import { describe, expect, it, vi } from "vitest";
import {
  commitBrowserUpload,
  createBrowserTicket,
  type FilesDb,
  type FilesTransport,
} from "../../src/gateway/services/appFiles/AppFilesService.js";

vi.mock("../../src/gateway/services/appFiles/appFilesClient.js", () => ({
  requestUploadTicket: vi.fn(() => {
    throw new Error("must not use the caller's key path");
  }),
  commitUpload: vi.fn(() => {
    throw new Error("must not use the caller's key path");
  }),
  createReadUrl: vi.fn(),
  deleteObject: vi.fn(),
  setVisibility: vi.fn(),
}));

/** Minimal FilesDb: remembers app_files rows by object_key (enough for the lifecycle). */
function makeDb(): FilesDb & { rows: Map<string, { id: string; state: string }> } {
  const rows = new Map<string, { id: string; state: string }>();
  return {
    rows,
    exec: () => undefined,
    run: (sql, params = []) => {
      if (/^\s*INSERT INTO app_files/i.test(sql)) {
        const [id, , key] = params as string[];
        const state = String(params[8]);
        const prev = rows.get(key);
        rows.set(key, { id: prev?.id ?? id, state });
      } else if (/UPDATE app_files\s+SET upload_state/i.test(sql)) {
        const key = String(params[params.length - 1]);
        const row = rows.get(key);
        if (row) row.state = String(params[0]);
      }
      return { changes: 1 };
    },
    all: <T,>(sql: string, params: unknown[] = []) => {
      const hit = [...rows.entries()].find(([k, r]) => k === params[0] || r.id === params[0]);
      if (!hit) return [] as T[];
      return [{ id: hit[1].id, upload_state: hit[1].state, object_key: hit[0], visibility: "inherit", scope: "app", sha256: "" }] as T[];
    },
  };
}

const KEY = `namespaces/ns/apps/app-1/files/${"a".repeat(64)}`;

function transport(verified = true): FilesTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async ticket(a) {
      calls.push(`ticket:${a.appId}:${a.sizeBytes}:${a.scope}`);
      return { object_key: KEY, upload_url: "https://gcs/u", already_exists: false };
    },
    async commit(appId, key, size) {
      calls.push(`commit:${appId}:${key === KEY}:${size}`);
      return { verified };
    },
  };
}

describe("published-app upload transport", () => {
  it("signed-out visitor: ticket + commit go through the transport, no key needed", async () => {
    const db = makeDb();
    const t = transport();
    const ticket = await createBrowserTicket(db, {
      appId: "app-1",
      fileName: "resume.pdf",
      sizeBytes: 1234,
      fingerprint: "a".repeat(64),
      transport: t,
    });
    expect(ticket.uploadUrl).toBe("https://gcs/u");
    const done = await commitBrowserUpload(db, {
      appId: "app-1",
      id: ticket.id,
      objectKey: ticket.objectKey,
      sizeBytes: 1234,
      transport: t,
    });
    expect(done.verified).toBe(true);
    expect(t.calls).toEqual(["ticket:app-1:1234:app", `commit:app-1:true:1234`]);
    expect([...db.rows.values()].map((r) => r.state)).toEqual(["verified"]);
  });

  it("an unverified commit marks the row failed", async () => {
    const db = makeDb();
    const t = transport(false);
    const ticket = await createBrowserTicket(db, {
      appId: "app-1", fileName: "x", sizeBytes: 5, fingerprint: "a".repeat(64), transport: t,
    });
    await commitBrowserUpload(db, { appId: "app-1", id: ticket.id, objectKey: KEY, sizeBytes: 5, transport: t });
    expect([...db.rows.values()].map((r) => r.state)).toEqual(["failed"]);
  });
});
