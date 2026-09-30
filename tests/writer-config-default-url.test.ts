import { afterEach, beforeEach, describe, expect, test } from "vitest";

const ENV_KEYS = ["PAPR_APP_REPO_WRITER_URL", "SYNC_WRITER_URL"] as const;

describe("app-repo-writer base URL resolution", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("defaults to the Cloud Run writer, never localhost", async () => {
    const { getAppRepoWriterBaseUrl, PRODUCTION_APP_REPO_WRITER_URL } =
      await import("../src/gateway/services/syncV3/writerConfig.js");

    // Regression: a localhost default made every Upload now fail with
    // "fetch failed" (ECONNREFUSED) whenever packaged env was missing.
    expect(getAppRepoWriterBaseUrl()).toBe(PRODUCTION_APP_REPO_WRITER_URL);
    expect(getAppRepoWriterBaseUrl()).not.toMatch(/127\.0\.0\.1|localhost/);
  });

  test("PAPR_APP_REPO_WRITER_URL still wins for local dev", async () => {
    process.env.PAPR_APP_REPO_WRITER_URL = "http://127.0.0.1:8789";
    const { getAppRepoWriterBaseUrl, isLocalAppRepoWriter } = await import(
      "../src/gateway/services/syncV3/writerConfig.js"
    );

    expect(getAppRepoWriterBaseUrl()).toBe("http://127.0.0.1:8789");
    expect(isLocalAppRepoWriter()).toBe(true);
  });

  test("trailing slashes and blank values are handled", async () => {
    const { getAppRepoWriterBaseUrl, PRODUCTION_APP_REPO_WRITER_URL } =
      await import("../src/gateway/services/syncV3/writerConfig.js");

    process.env.PAPR_APP_REPO_WRITER_URL = "https://writer.example.com/";
    expect(getAppRepoWriterBaseUrl()).toBe("https://writer.example.com");

    // A blank override must not strand sync on an empty host.
    process.env.PAPR_APP_REPO_WRITER_URL = "   ";
    expect(getAppRepoWriterBaseUrl()).toBe(PRODUCTION_APP_REPO_WRITER_URL);
  });

  test("SYNC_WRITER_URL is honoured as a fallback override", async () => {
    process.env.SYNC_WRITER_URL = "https://staging-writer.example.com";
    const { getAppRepoWriterBaseUrl, isLocalAppRepoWriter } = await import(
      "../src/gateway/services/syncV3/writerConfig.js"
    );

    expect(getAppRepoWriterBaseUrl()).toBe("https://staging-writer.example.com");
    expect(isLocalAppRepoWriter()).toBe(false);
  });
});
