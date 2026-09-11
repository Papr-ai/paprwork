import { describe, expect, it } from "vitest";

import { isRetryableProviderStreamFailure } from "../src/gateway/services/agent/streamOrchestrator.js";
import { explainPostStreamWrapUp } from "../src/gateway/services/agent/turnEndDiagnostics.js";
import { resolveStepContextTokens } from "../src/gateway/services/agent/stepContextTokens.js";

/**
 * Reproduces the error the AI SDK handed up when a real turn died mid-work:
 * three attempts against api.anthropic.com, each retryable, the last two
 * closed by the peer. The whole reason this shape is rebuilt here rather than
 * simplified is that the classifier has to reach the cause chain through
 * `errors[]` and `lastError`, not just `cause`.
 */
function retryErrorFromLog(): unknown {
  const socketError = Object.assign(new Error("other side closed"), {
    code: "UND_ERR_SOCKET",
  });
  const apiCallError = (cause: Error) =>
    Object.assign(new Error("Cannot connect to API: other side closed"), {
      name: "AI_APICallError",
      url: "https://api.anthropic.com/v1/messages",
      statusCode: undefined,
      isRetryable: true,
      cause,
    });
  const first = Object.assign(
    new Error("Cannot connect to API: read ECONNRESET"),
    {
      name: "AI_APICallError",
      url: "https://api.anthropic.com/v1/messages",
      statusCode: undefined,
      isRetryable: true,
      cause: Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
      }),
    },
  );
  const last = apiCallError(socketError);
  return Object.assign(
    new Error(
      "Failed after 3 attempts. Last error: Cannot connect to API: other side closed",
    ),
    {
      name: "AI_RetryError",
      reason: "maxRetriesExceeded",
      errors: [first, apiCallError(socketError), last],
      lastError: last,
    },
  );
}

describe("isRetryableProviderStreamFailure", () => {
  it("recognises the retry-exhausted transport failure from the real log", () => {
    expect(isRetryableProviderStreamFailure(retryErrorFromLog())).toBe(true);
  });

  it("recognises a socket close with no ECONNRESET anywhere in the chain", () => {
    // The live failure only matched on master because its *first* attempt
    // happened to be ECONNRESET. Three identical UND_ERR_SOCKET attempts —
    // equally likely — fell through to a generic message and, worse, let the
    // wrap-up treat the turn as complete.
    const socket = Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET",
    });
    expect(isRetryableProviderStreamFailure(socket)).toBe(true);
  });

  it("recognises a socket hang up", () => {
    expect(
      isRetryableProviderStreamFailure(new Error("socket hang up")),
    ).toBe(true);
  });

  it("does not claim a rate limit is a transport failure", () => {
    // A 429 carries a status code, so no resume is promised for it. Waiting is
    // the remedy there, and for a spend cap waiting does not help at all —
    // either way it is not this classifier's business.
    const rateLimited = Object.assign(new Error("Rate limit exceeded"), {
      url: "https://api.anthropic.com/v1/messages",
      statusCode: 429,
      isRetryable: true,
    });
    expect(isRetryableProviderStreamFailure(rateLimited)).toBe(false);
  });

  it("does not claim an auth rejection is a transport failure", () => {
    const unauthorized = Object.assign(new Error("invalid x-api-key"), {
      url: "https://api.anthropic.com/v1/messages",
      statusCode: 401,
      isRetryable: false,
    });
    expect(isRetryableProviderStreamFailure(unauthorized)).toBe(false);
  });

  it("does not fire on an ordinary error", () => {
    expect(isRetryableProviderStreamFailure(new Error("boom"))).toBe(false);
    expect(isRetryableProviderStreamFailure(undefined)).toBe(false);
  });
});

describe("explainPostStreamWrapUp with a failed stream", () => {
  /** Tools ran and completed, no trailing text — the wrap-up's own trigger. */
  const toolsThenSilence = {
    sequence: [
      { type: "text", data: { text: "I'll check the readiness doc." } },
      { type: "tool", data: { status: "success", name: "bash" } },
      { type: "tool", data: { status: "success", name: "bash" } },
    ],
    toolCallCount: 2,
    aborted: false,
    isWrapUpContinuation: false,
  };

  it("requests the wrap-up when the stream finished normally", () => {
    expect(explainPostStreamWrapUp(toolsThenSilence)).toEqual({
      requested: true,
    });
  });

  it("suppresses the wrap-up when the stream died in transport", () => {
    // This is the bug: the two situations are indistinguishable from the
    // sequence alone, so a dropped connection got answered with a recap of
    // tool calls instead of the answer the user asked for.
    expect(
      explainPostStreamWrapUp({
        ...toolsThenSilence,
        providerStreamFailed: true,
      }),
    ).toEqual({ requested: false, skipReason: "provider_stream_failed" });
  });

  it("still reports abort as the reason when the user cancelled", () => {
    // A cancel the user initiated is a more accurate explanation than the
    // dropped stream it may also have caused.
    expect(
      explainPostStreamWrapUp({
        ...toolsThenSilence,
        aborted: true,
        providerStreamFailed: true,
      }),
    ).toEqual({ requested: false, skipReason: "aborted" });
  });

  it("leaves every other skip reason unchanged", () => {
    expect(
      explainPostStreamWrapUp({ ...toolsThenSilence, toolCallCount: 0 }),
    ).toEqual({ requested: false, skipReason: "no_tool_calls" });
    expect(
      explainPostStreamWrapUp({
        ...toolsThenSilence,
        isWrapUpContinuation: true,
      }),
    ).toEqual({ requested: false, skipReason: "wrap_up_continuation" });
  });
});

describe("resolveStepContextTokens", () => {
  it("does not double-count when the provider already summed the cache", () => {
    // The three steps below are the figures from the real turn.
    // @ai-sdk/anthropic 3.x maps inputTokens to
    // `input_tokens + cache_creation + cache_read`, so each of these is
    // already the whole context. Master reported them as 769K, 770K and 772K.
    expect(
      resolveStepContextTokens({
        inputTokens: 384390,
        cacheReadTokens: 0,
        cacheWriteTokens: 384388,
      }),
    ).toBe(384390);
    expect(
      resolveStepContextTokens({
        inputTokens: 384853,
        cacheReadTokens: 384388,
        cacheWriteTokens: 463,
      }),
    ).toBe(384853);
    expect(
      resolveStepContextTokens({
        inputTokens: 385872,
        cacheReadTokens: 384851,
        cacheWriteTokens: 1019,
      }),
    ).toBe(385872);
  });

  it("adds the cache when the provider reports only the uncached remainder", () => {
    expect(
      resolveStepContextTokens({
        inputTokens: 1200,
        cacheReadTokens: 90000,
        cacheWriteTokens: 500,
      }),
    ).toBe(91700);
  });

  it("passes the input through when no cache is in play", () => {
    expect(resolveStepContextTokens({ inputTokens: 5000 })).toBe(5000);
    expect(
      resolveStepContextTokens({
        inputTokens: 5000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(5000);
  });
});
