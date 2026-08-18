import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  coalesce,
  isTransientTransportError,
  parseFetch,
  ParseCircuitOpenError,
  resetParseTransportState,
} from "../src/electron/ipc/parseTransport.js";

const URL_A = "https://parse.test/graphql";

function jsonResponse(status = 200): Response {
  return new Response(JSON.stringify({ data: {} }), { status });
}

function connectionReset(): Error {
  const error = new TypeError("fetch failed");
  (error as Error & { cause?: unknown }).cause = Object.assign(
    new Error("read ECONNRESET"),
    { code: "ECONNRESET" },
  );
  return error;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetParseTransportState();
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetParseTransportState();
});

/**
 * Drive fake timers until the promise settles, so backoff sleeps resolve.
 *
 * Advances in small steps and stops as soon as it settles: over-advancing would
 * push the mocked clock past the circuit-breaker window and change behaviour.
 */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const raced = promise.then(
    (value) => {
      settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    },
  );

  for (let i = 0; i < 200 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(25);
  }

  const result = await raced;
  if (result.ok) return result.value;
  throw result.error;
}

describe("isTransientTransportError", () => {
  it("treats connection resets and 5xx as retryable", () => {
    expect(isTransientTransportError(connectionReset())).toBe(true);
    expect(isTransientTransportError(new Error("Parse error: 503 busy"))).toBe(true);
    expect(isTransientTransportError(new Error("ETIMEDOUT"))).toBe(true);
  });

  it("does not retry auth or validation failures", () => {
    expect(isTransientTransportError(new Error("Parse error: 401 bad token"))).toBe(
      false,
    );
    expect(isTransientTransportError(new Error("Invalid session"))).toBe(false);
  });
});

describe("parseFetch retry", () => {
  it("retries a connection reset and succeeds", async () => {
    fetchMock
      .mockRejectedValueOnce(connectionReset())
      .mockResolvedValueOnce(jsonResponse());

    const response = await settle(parseFetch(URL_A));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt budget instead of retrying forever", async () => {
    fetchMock.mockRejectedValue(connectionReset());

    await expect(settle(parseFetch(URL_A))).rejects.toThrow();

    // 3 attempts by default — not an unbounded retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 4xx", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403));

    const response = await settle(parseFetch(URL_A));

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honours maxAttempts: 1 for mutations", async () => {
    fetchMock.mockRejectedValue(connectionReset());

    await expect(settle(parseFetch(URL_A, { maxAttempts: 1 }))).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes an abort signal so a hung socket cannot be held open", async () => {
    fetchMock.mockResolvedValue(jsonResponse());

    await settle(parseFetch(URL_A));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("parseFetch concurrency cap", () => {
  it("never opens more than the cap against one origin at a time", async () => {
    let active = 0;
    let peak = 0;

    fetchMock.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return jsonResponse();
    });

    const requests = Array.from({ length: 20 }, () => parseFetch(URL_A));
    await settle(Promise.all(requests));

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("parseFetch circuit breaker", () => {
  it("stops calling an origin that keeps failing", async () => {
    fetchMock.mockRejectedValue(connectionReset());

    // Two calls × 3 attempts = 6 consecutive failures, hitting the threshold.
    await expect(settle(parseFetch(URL_A))).rejects.toThrow();
    await expect(settle(parseFetch(URL_A))).rejects.toThrow();
    const callsBeforeOpen = fetchMock.mock.calls.length;

    // No timer advance: within the open window the call must fail immediately,
    // without reaching the network.
    await expect(parseFetch(URL_A)).rejects.toBeInstanceOf(ParseCircuitOpenError);

    expect(fetchMock.mock.calls.length).toBe(callsBeforeOpen);
  });

  it("probes again after the open window and closes on success", async () => {
    fetchMock.mockRejectedValue(connectionReset());
    await expect(settle(parseFetch(URL_A))).rejects.toThrow();
    await expect(settle(parseFetch(URL_A))).rejects.toThrow();
    await expect(settle(parseFetch(URL_A))).rejects.toBeInstanceOf(
      ParseCircuitOpenError,
    );

    await vi.advanceTimersByTimeAsync(31_000);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse());

    const response = await settle(parseFetch(URL_A));
    expect(response.status).toBe(200);

    // Circuit closed, so normal traffic flows again.
    const next = await settle(parseFetch(URL_A));
    expect(next.status).toBe(200);
  });
});

describe("coalesce", () => {
  it("shares one run between concurrent callers with the same key", async () => {
    const run = vi.fn(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("value"), 10)),
    );

    const results = await settle(
      Promise.all([
        coalesce("k", run),
        coalesce("k", run),
        coalesce("k", run),
      ]),
    );

    expect(results).toEqual(["value", "value", "value"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not share across different keys", async () => {
    const run = vi.fn(() => Promise.resolve("value"));

    await settle(Promise.all([coalesce("a", run), coalesce("b", run)]));

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("releases the key so later callers run again", async () => {
    const run = vi.fn(() => Promise.resolve("value"));

    await settle(coalesce("k", run));
    await settle(coalesce("k", run));

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("propagates a rejection to every waiter and clears the key", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("boom")));

    const first = coalesce("k", failing);
    const second = coalesce("k", failing);

    await expect(settle(first)).rejects.toThrow("boom");
    await expect(settle(second)).rejects.toThrow("boom");
    expect(failing).toHaveBeenCalledTimes(1);

    await expect(settle(coalesce("k", failing))).rejects.toThrow("boom");
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
