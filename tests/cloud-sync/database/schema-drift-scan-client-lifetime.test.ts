import { describe, expect, it } from "vitest";

/**
 * Regression: the Turso client was closed while the drift scan was still
 * querying it, so every Upload failed with:
 *
 *   UNKNOWN: Client was closed: ClientError: Client was manually closed
 *
 * Cause: `return someAsyncFn(...)` inside `try { } finally { client.close() }`.
 * `return promise` (without `await`) hands the promise back to the caller and
 * runs `finally` immediately — the client is closed while the scan is still
 * issuing queries. `return await` keeps the frame alive until the scan
 * finishes, so the close happens after the last query.
 *
 * These tests model the lifetime rule directly, without needing a real
 * libSQL connection.
 */

interface FakeClient {
  closed: boolean;
  execute: () => Promise<string>;
  close: () => void;
}

function createFakeClient(): FakeClient {
  const client: FakeClient = {
    closed: false,
    execute: async () => {
      // Any real round-trip yields to the event loop at least once, which is
      // what lets a premature finally block run first.
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (client.closed) {
        throw new Error("Client was manually closed");
      }
      return "ok";
    },
    close: () => {
      client.closed = true;
    },
  };
  return client;
}

/** Multi-query scan, like localRemoteUserSchemaDriftTables over N tables. */
async function scanTables(client: FakeClient, tableCount: number): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < tableCount; i += 1) {
    seen.push(await client.execute());
  }
  return seen;
}

describe("drift scan client lifetime", () => {
  it("keeps the client open until the scan finishes (return await)", async () => {
    const client = createFakeClient();

    async function listDriftedTables(): Promise<string[]> {
      try {
        return await scanTables(client, 3);
      } finally {
        client.close();
      }
    }

    await expect(listDriftedTables()).resolves.toHaveLength(3);
    expect(client.closed).toBe(true); // still closed afterwards — no leak
  });

  it("reproduces the failure when the await is missing", async () => {
    const client = createFakeClient();

    async function listDriftedTablesBuggy(): Promise<string[]> {
      try {
        // The exact shape of the bug: no await, so finally runs first.
        return scanTables(client, 3);
      } finally {
        client.close();
      }
    }

    await expect(listDriftedTablesBuggy()).rejects.toThrow(
      "Client was manually closed",
    );
  });

  it("closes the client even when the scan throws", async () => {
    const client = createFakeClient();

    async function listDriftedTablesFailing(): Promise<string[]> {
      try {
        return await Promise.reject(new Error("remote unreachable"));
      } finally {
        client.close();
      }
    }

    await expect(listDriftedTablesFailing()).rejects.toThrow(
      "remote unreachable",
    );
    expect(client.closed).toBe(true);
  });
});
