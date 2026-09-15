/**
 * The OAuth/API-key refresh in `getProviderAuth` is a backstop, and a caller that
 * already holds a usable credential must not wait for it.
 *
 * Main pushes INVALIDATE_KEY_CACHE on every credential change — auth-mode toggle,
 * OAuth refresh, key add/edit/delete — and `clearKeyCache` drops the cached token
 * and zeroes the TTL, so a switch always arrives with nothing in hand. The TTL
 * refresh only catches what a push missed.
 *
 * Before this, every call past the 8s TTL blocked on the IPC round trip for up to
 * 15s and then, on timeout, fell back to the cached value it already had. On the
 * reported machine that landed on each agent turn and on each of 135 files the
 * code indexer summarized.
 */

import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  clearKeyCache,
  getProviderAuth,
} from "../src/gateway/utils/keyResolver.js";
import type {
  KeysResponseMessage,
  RequestKeysMessage,
} from "../src/core/types/gateway-ipc.js";

const HOUR = 60 * 60 * 1000;

/**
 * A main process that answers only when told to, so "did this call wait?" is a
 * question the test controls rather than races.
 *
 * Every instance registers itself for teardown: requests are coalesced in a
 * module-level map keyed by key name, and under fake timers the 15s timeout that
 * would normally clear a stalled entry never fires — so a request left unreleased
 * by one test is joined, and waited on forever, by the next.
 */
const liveIpcs: DeferredIpc[] = [];

class DeferredIpc extends EventEmitter {
  public sent: RequestKeysMessage[] = [];
  /** Counts attempts including the ones that throw, which `sent` cannot. */
  public sendAttempts = 0;
  public failSend = false;
  private pending: RequestKeysMessage[] = [];

  constructor(private readonly reply: () => KeysResponseMessage["oauthTokens"]) {
    super();
    liveIpcs.push(this);
  }

  send = (message: unknown): void => {
    this.sendAttempts += 1;
    if (this.failSend) throw new Error("channel closed");
    const request = message as RequestKeysMessage;
    this.sent.push(request);
    this.pending.push(request);
  };

  release(): void {
    const queued = this.pending;
    this.pending = [];
    for (const request of queued) {
      this.emit("message", {
        type: "KEYS_RESPONSE",
        requestId: request.requestId,
        keys: {},
        oauthTokens: this.reply(),
      } satisfies KeysResponseMessage);
    }
  }
}

/** Let any already-queued microtasks run, so "not settled" means it really is not. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function token(accessToken: string): KeysResponseMessage["oauthTokens"] {
  return {
    anthropic: {
      accessToken,
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    },
  };
}

describe("backstop refresh does not block a caller that already has a credential", () => {
  beforeEach(() => {
    clearKeyCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
  });

  afterEach(async () => {
    // Drain anything a test left deliberately unanswered, or the next test joins
    // that coalesced promise instead of making its own request.
    for (const ipc of liveIpcs.splice(0)) {
      ipc.failSend = false;
      ipc.release();
    }
    await drainMicrotasks();
    vi.useRealTimers();
    clearKeyCache();
  });

  test("cold start waits, because without main this call has no answer at all", async () => {
    const ipc = new DeferredIpc(() => token("sk-ant-oat01-first"));

    let settled = false;
    const pending = getProviderAuth("anthropic", ipc).then((auth) => {
      settled = true;
      return auth;
    });

    await drainMicrotasks();
    // Nothing cached: returning null here would report "not signed in" on a cold
    // start purely because main had not answered yet.
    expect(settled).toBe(false);
    expect(ipc.sent).toHaveLength(1);

    ipc.release();
    expect(await pending).toEqual({
      type: "oauth",
      token: "sk-ant-oat01-first",
    });
  });

  test("once a token is cached the refresh runs behind the caller, not in front of it", async () => {
    const ipc = new DeferredIpc(() => token("sk-ant-oat01-first"));
    const cold = getProviderAuth("anthropic", ipc);
    ipc.release();
    await cold;

    vi.setSystemTime(Date.now() + 9_000); // past OAUTH_IPC_REFRESH_TTL_MS

    let settled = false;
    const warm = getProviderAuth("anthropic", ipc).then((auth) => {
      settled = true;
      return auth;
    });

    await drainMicrotasks();

    // Resolved while main is still holding the reply — the whole point. Before
    // this change the same call sat here for the full IPC timeout and then used
    // this very token anyway.
    expect(settled).toBe(true);
    expect(await warm).toEqual({ type: "oauth", token: "sk-ant-oat01-first" });

    // Still asked, though: the backstop has to actually run, it just must not be
    // in the caller's way.
    expect(ipc.sent).toHaveLength(2);
  });

  test("the backgrounded answer lands in the cache for the next caller", async () => {
    let current = "sk-ant-oat01-first";
    const ipc = new DeferredIpc(() => token(current));

    const cold = getProviderAuth("anthropic", ipc);
    ipc.release();
    await cold;

    current = "sk-ant-oat01-rotated";
    vi.setSystemTime(Date.now() + 9_000);

    // Served from cache, so still the old token.
    expect(await getProviderAuth("anthropic", ipc)).toEqual({
      type: "oauth",
      token: "sk-ant-oat01-first",
    });

    ipc.release();
    await drainMicrotasks();

    expect(await getProviderAuth("anthropic", ipc)).toEqual({
      type: "oauth",
      token: "sk-ant-oat01-rotated",
    });
  });

  test("a failed refresh still counts as an attempt, so a slow main is asked once not forever", async () => {
    const ipc = new DeferredIpc(() => token("sk-ant-oat01-first"));
    const cold = getProviderAuth("anthropic", ipc);
    ipc.release();
    await cold;

    // Main goes unresponsive.
    ipc.failSend = true;

    vi.setSystemTime(Date.now() + 9_000);
    await getProviderAuth("anthropic", ipc);
    await getProviderAuth("anthropic", ipc);
    await getProviderAuth("anthropic", ipc);

    // The timestamp used to be advanced only after a *resolved* request, so while
    // main was slow every subsequent call found the TTL still stale and paid the
    // timeout again — back to back, for as long as main stayed slow. Three calls
    // inside one TTL window must produce one attempt.
    expect(ipc.sendAttempts).toBe(2); // the cold start, plus one failed attempt
  });

  test("an auth-mode switch is still honoured on the very next call", async () => {
    let withheld = false;
    const ipc = new DeferredIpc(() => (withheld ? {} : token("sk-ant-oat01-first")));

    const cold = getProviderAuth("anthropic", ipc);
    ipc.release();
    expect(await cold).toEqual({ type: "oauth", token: "sk-ant-oat01-first" });

    // What main sends when the user switches to API key, plus the push it sends
    // with it. This is the case the blocking refresh existed to cover, and it is
    // covered by the invalidation rather than by the wait.
    withheld = true;
    clearKeyCache("ANTHROPIC_API_KEY");

    let settled = false;
    const after = getProviderAuth("anthropic", ipc).then((auth) => {
      settled = true;
      return auth;
    });

    await drainMicrotasks();
    // Blocks, because clearKeyCache dropped the token: there is nothing to serve.
    expect(settled).toBe(false);

    ipc.release();
    expect(await after).not.toEqual({
      type: "oauth",
      token: "sk-ant-oat01-first",
    });
  });
});
