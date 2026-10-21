/**
 * Oct 20 regression: after switching 85ZIB7mD1V → XHqOmymyGP the gateway kept
 * using 85ZIB7mD1V's LEGACY Papr API key (no namespace embedded in the string).
 * The cloud rejected every call ("API key is bound to namespace 85ZIB7mD1V"),
 * Turso tokens fetched with it pointed at the other workspace's databases, and
 * publish status cached "not published" for an hour.
 *
 * These pin the guards that stop each link in that chain.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  clearKeyCache,
  getCachedPaprApiKeyNamespace,
  getPaprApiKey,
} from "../src/gateway/utils/keyResolver.js";
import type {
  KeysResponseMessage,
  RequestKeysMessage,
} from "../src/core/types/gateway-ipc.js";

const ORG = "orgAAAAAAAA";
const NS_OLD = "nsOLDOLDOLD";
const NS_NEW = "nsNEWNEWNEW";
/** Legacy format: no `sk-org-…-namespace-…` scope in the string. */
const LEGACY_KEY = "pk_legacy_0123456789abcdef0123456789abcdef";

function setActive(ns: string): void {
  process.env.PAPR_ORG_ID = ORG;
  process.env.PAPR_NAMESPACE_ID = ns;
}

/** Main process that answers only when the test says so. */
class DeferredMain extends EventEmitter {
  pending: RequestKeysMessage[] = [];
  send = (message: unknown): void => {
    this.pending.push(message as RequestKeysMessage);
  };
  answer(keys: Record<string, string>, paprApiKeyNamespaceId?: string): void {
    const queued = this.pending.splice(0);
    for (const request of queued) {
      this.emit("message", {
        type: "KEYS_RESPONSE",
        requestId: request.requestId,
        keys,
        ...(paprApiKeyNamespaceId ? { paprApiKeyNamespaceId } : {}),
        oauthTokens: {},
      } satisfies KeysResponseMessage);
    }
  }
}

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("PAPR_API_KEY stays bound to the workspace it was resolved for", () => {
  const saved = {
    org: process.env.PAPR_ORG_ID,
    ns: process.env.PAPR_NAMESPACE_ID,
    key: process.env.PAPR_API_KEY,
  };

  beforeEach(() => {
    delete process.env.PAPR_API_KEY;
    setActive(NS_OLD);
    clearKeyCache();
  });

  afterEach(() => {
    clearKeyCache();
    process.env.PAPR_ORG_ID = saved.org;
    process.env.PAPR_NAMESPACE_ID = saved.ns;
    if (saved.key === undefined) delete process.env.PAPR_API_KEY;
    else process.env.PAPR_API_KEY = saved.key;
  });

  test("a legacy key is used in the workspace it was resolved for", async () => {
    const main = new DeferredMain();
    const pending = getPaprApiKey(main);
    await drain();
    main.answer({ PAPR_API_KEY: LEGACY_KEY }, NS_OLD);
    expect(await pending).toBe(LEGACY_KEY);
    expect(getCachedPaprApiKeyNamespace()).toBe(NS_OLD);
  });

  test("a cached legacy key is NOT reused after the active workspace changes", async () => {
    const main = new DeferredMain();
    const first = getPaprApiKey(main);
    await drain();
    main.answer({ PAPR_API_KEY: LEGACY_KEY }, NS_OLD);
    expect(await first).toBe(LEGACY_KEY);

    // Pointer moves without anyone clearing the key cache.
    setActive(NS_NEW);
    const second = getPaprApiKey(main);
    await drain();
    main.answer({}); // main has nothing for the new workspace yet
    expect(await second).toBeUndefined();
  });

  test("an answer that lands after a switch is dropped, not cached", async () => {
    const main = new DeferredMain();
    const pending = getPaprApiKey(main); // asked while NS_OLD active
    await drain();

    // Switch happens while the request is in flight.
    setActive(NS_NEW);
    clearKeyCache("PAPR_API_KEY");

    main.answer({ PAPR_API_KEY: LEGACY_KEY }, NS_OLD);
    expect(await pending).toBeUndefined();
    expect(getCachedPaprApiKeyNamespace()).toBeNull();
  });

  test("main resolving for a different namespace than the gateway's is rejected", async () => {
    setActive(NS_NEW);
    const main = new DeferredMain();
    const pending = getPaprApiKey(main);
    await drain();
    // Main's pointer was still on the old workspace when it answered.
    main.answer({ PAPR_API_KEY: LEGACY_KEY }, NS_OLD);
    expect(await pending).toBeUndefined();
  });
});

describe("Turso credentials fetched with another workspace's key", () => {
  const paprDir = path.join(os.tmpdir(), `turso-misbound-test-${process.pid}`);
  const filedUnder = `${ORG}/${NS_NEW}/user1111111/d-1ff4bc68`;

  afterEach(() => {
    fs.rmSync(paprDir, { recursive: true, force: true });
  });

  test("are refused on save", async () => {
    const { saveTursoCredentialsEntry, loadTursoCredentialsStore } = await import(
      "../src/gateway/services/tursoCredentialsStore.js"
    );
    saveTursoCredentialsEntry(
      filedUnder,
      { tursoUrl: "libsql://p-orgaaaaa-nsoldold-d-1ff4bc68", authToken: "t" },
      Date.now() + 3_600_000,
      paprDir,
      NS_OLD,
    );
    expect(loadTursoCredentialsStore(paprDir).databases[filedUnder]).toBeUndefined();
  });

  test("already on disk are dropped on read", async () => {
    const { saveTursoCredentialsStore, getTursoCredentialsEntry, loadTursoCredentialsStore } =
      await import("../src/gateway/services/tursoCredentialsStore.js");
    saveTursoCredentialsStore(
      {
        databases: {
          [filedUnder]: {
            tursoUrl: "libsql://p-orgaaaaa-nsoldold-d-1ff4bc68",
            authToken: "t",
            expiresAtMs: Date.now() + 3_600_000,
            updatedAt: new Date().toISOString(),
            keyNamespaceId: NS_OLD,
          },
        },
      },
      paprDir,
    );
    expect(getTursoCredentialsEntry(filedUnder, paprDir)).toBeNull();
    expect(loadTursoCredentialsStore(paprDir).databases[filedUnder]).toBeUndefined();
  });

  test("matching-namespace credentials still round-trip", async () => {
    const { saveTursoCredentialsEntry, getTursoCredentialsEntry } = await import(
      "../src/gateway/services/tursoCredentialsStore.js"
    );
    saveTursoCredentialsEntry(
      filedUnder,
      { tursoUrl: "libsql://p-orgaaaaa-nsnewnew-d-1ff4bc68", authToken: "t" },
      Date.now() + 3_600_000,
      paprDir,
      NS_NEW,
    );
    expect(getTursoCredentialsEntry(filedUnder, paprDir)?.keyNamespaceId).toBe(NS_NEW);
  });
});

describe("cloud repo token errors keep the cloud's reason", () => {
  test("detail from a JSON error body is surfaced", async () => {
    const { describeCloudErrorBody } = await import(
      "../src/gateway/services/cloudSync/cloudSyncToken.js"
    );
    const body = JSON.stringify({
      detail:
        "API key is bound to namespace '85ZIB7mD1V'; cannot operate on namespace 'XHqOmymyGP'.",
    });
    expect(describeCloudErrorBody(403, body)).toBe(
      "403: API key is bound to namespace '85ZIB7mD1V'; cannot operate on namespace 'XHqOmymyGP'.",
    );
    expect(describeCloudErrorBody(500, "upstream down")).toBe("500: upstream down");
  });
});
