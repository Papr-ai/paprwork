/**
 * Tests for upload durability decisions.
 *
 * The scenario driving all of this: a 10 GB recording, a laptop that dies at
 * 9 GB. Each test names the user-visible cost it prevents.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY,
  SESSION_MIN_REMAINING_MS,
  backoffDelayMs,
  isHashCacheValid,
  isRetryableStatus,
  planResume,
  shouldRetry,
  type ResumeCandidate,
} from "../../../src/gateway/services/appFiles/uploadResume.js";

const NOW = 1_700_000_000_000;
const GB = 1024 ** 3;

function row(over: Partial<ResumeCandidate> = {}): ResumeCandidate {
  return {
    upload_session_uri: "https://storage.googleapis.com/upload/session-abc",
    session_expires_at: NOW + 7 * 24 * 60 * 60 * 1000,
    upload_state: "uploading",
    size_bytes: 10 * GB,
    ...over,
  };
}

describe("planResume", () => {
  it("resumes a live session instead of re-sending 10 GB", () => {
    // The whole point of 4a: a laptop dying at 9 GB must not cost 10 GB.
    const plan = planResume(row(), NOW);
    expect(plan).toMatchObject({ kind: "resume" });
  });

  it("restarts when no session was ever stored", () => {
    // The pre-4a state of the world: the URI lived in a local variable and
    // died with the process.
    const plan = planResume(row({ upload_session_uri: null }), NOW);
    expect(plan).toMatchObject({ kind: "restart" });
  });

  it("restarts once the 7-day session has expired", () => {
    const plan = planResume(row({ session_expires_at: NOW - 1 }), NOW);
    expect(plan).toMatchObject({ kind: "restart", reason: /expired/ as never });
  });

  it("restarts when too little session life remains for a large upload", () => {
    // Resuming onto a session with minutes left moves the failure to the worst
    // moment — near the end, after hours of transfer.
    const plan = planResume(
      row({ session_expires_at: NOW + SESSION_MIN_REMAINING_MS - 1 }),
      NOW,
    );
    expect(plan).toMatchObject({ kind: "restart" });
  });

  it("restarts when the session has no recorded expiry", () => {
    // Cannot date it, cannot trust it to outlive a multi-hour upload.
    const plan = planResume(row({ session_expires_at: null }), NOW);
    expect(plan).toMatchObject({ kind: "restart" });
  });

  it("does nothing for an already-verified file", () => {
    const plan = planResume(row({ upload_state: "verified" }), NOW);
    expect(plan).toMatchObject({ kind: "done" });
  });

  it("resumes a failed upload rather than abandoning it", () => {
    // 'failed' is where a crashed upload lands. It must still be resumable, or
    // the state itself becomes a dead end.
    const plan = planResume(row({ upload_state: "failed" }), NOW);
    expect(plan).toMatchObject({ kind: "resume" });
  });
});

describe("shouldRetry", () => {
  it("retries a dropped connection, which has no status at all", () => {
    expect(shouldRetry(1, null)).toBe(true);
  });

  it("retries GCS transient failures", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(shouldRetry(1, status), String(status)).toBe(true);
    }
  });

  it("does not retry a client error that will never succeed", () => {
    // Retrying a 403 six times just delays the error message.
    for (const status of [400, 401, 403, 404]) {
      expect(shouldRetry(1, status), String(status)).toBe(false);
    }
  });

  it("stops at the attempt ceiling", () => {
    expect(shouldRetry(DEFAULT_RETRY.maxAttempts, 503)).toBe(false);
  });

  it("classifies statuses consistently with the retry decision", () => {
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially across attempts", () => {
    const noJitter = () => 1;
    expect(backoffDelayMs(1, DEFAULT_RETRY, noJitter)).toBe(1000);
    expect(backoffDelayMs(2, DEFAULT_RETRY, noJitter)).toBe(2000);
    expect(backoffDelayMs(3, DEFAULT_RETRY, noJitter)).toBe(4000);
  });

  it("caps the delay so a retry never stalls for hours", () => {
    expect(backoffDelayMs(20, DEFAULT_RETRY, () => 1)).toBe(
      DEFAULT_RETRY.maxDelayMs,
    );
  });

  it("applies jitter so concurrent uploads do not retry in lockstep", () => {
    // Without jitter every chunk of every upload hits GCS on the same schedule,
    // hammering it hardest exactly when it is already struggling.
    expect(backoffDelayMs(3, DEFAULT_RETRY, () => 0)).toBe(0);
    expect(backoffDelayMs(3, DEFAULT_RETRY, () => 0.5)).toBe(2000);
  });
});

describe("isHashCacheValid", () => {
  const actual = { size: 10 * GB, mtimeMs: 1_699_999_000_000 };

  it("skips rehashing 10 GB when the file is untouched", () => {
    // Two full passes over 10 GB is minutes of CPU. After a crash we would
    // otherwise pay it again to learn the same answer.
    const cached = {
      size_bytes: actual.size,
      mtime_ms: actual.mtimeMs,
      sha256: "abc",
    };
    expect(isHashCacheValid(cached, actual)).toBe(true);
  });

  it("rehashes when the size changed", () => {
    const cached = { size_bytes: 1, mtime_ms: actual.mtimeMs, sha256: "abc" };
    expect(isHashCacheValid(cached, actual)).toBe(false);
  });

  it("rehashes when the file was modified", () => {
    const cached = { size_bytes: actual.size, mtime_ms: 1, sha256: "abc" };
    expect(isHashCacheValid(cached, actual)).toBe(false);
  });

  it("rehashes when nothing is cached", () => {
    expect(isHashCacheValid(null, actual)).toBe(false);
  });
});
