import { afterEach, describe, expect, test } from "vitest";
import {
  MiniAppApiErrorSchema,
  MiniAppDbExecResponseSchema,
  MiniAppDbQueryResponseSchema,
  MiniAppDbWriteBatchResponseSchema,
  MiniAppDbWriteResponseSchema,
  MiniAppDbWriteRequestSchema,
  MiniAppDbWriteBatchRequestSchema,
  MiniAppJobRunAsyncResponseSchema,
  MiniAppJobRunConflictResponseSchema,
  MiniAppJobRunRequestSchema,
  MiniAppJobRunWaitResponseSchema,
  MiniAppJobStatusResponseSchema,
  MiniAppJobsListResponseSchema,
} from "../src/core/types/miniAppApiContract.js";

describe("mini-app API contract (frozen §8.2)", () => {
  test("POST /api/db/write success shape", () => {
    const parsed = MiniAppDbWriteResponseSchema.safeParse({
      changes: 3,
      lastInsertRowid: 42,
    });
    expect(parsed.success).toBe(true);
  });

  test("POST /api/db/write-batch success shape", () => {
    expect(
      MiniAppDbWriteBatchResponseSchema.safeParse({
        results: [
          { ok: true, changes: 1, lastInsertRowid: 42, source: "primary" },
          { ok: false, error: "constraint failed" },
        ],
      }).success,
    ).toBe(true);
  });

  test("POST /api/db/write error shape", () => {
    expect(
      MiniAppApiErrorSchema.safeParse({ error: "sql is required" }).success,
    ).toBe(true);
  });

  test("POST /api/db/query success shape (gateway may add source alias)", () => {
    expect(
      MiniAppDbQueryResponseSchema.safeParse({
        rows: [{ id: 1, name: "alpha" }],
        count: 1,
        backend: "local",
        source: "primary",
      }).success,
    ).toBe(true);
  });

  test("POST /api/db/exec success shape", () => {
    expect(MiniAppDbExecResponseSchema.safeParse({ success: true }).success).toBe(
      true,
    );
  });

  test("POST /api/jobs/run async success shape", () => {
    expect(
      MiniAppJobRunAsyncResponseSchema.safeParse({
        jobId: "job-1",
        status: "running",
      }).success,
    ).toBe(true);
  });

  test("POST /api/jobs/run wait=true success shape", () => {
    expect(
      MiniAppJobRunWaitResponseSchema.safeParse({
        jobId: "job-1",
        status: "completed",
        completedAt: "2026-08-18T12:00:00.000Z",
        lastOutput: "done",
      }).success,
    ).toBe(true);
  });

  test("POST /api/jobs/run 409 collision shape", () => {
    expect(
      MiniAppJobRunConflictResponseSchema.safeParse({
        jobId: "job-1",
        status: "running",
        error: "Job already running",
        reason: "already_running",
      }).success,
    ).toBe(true);
    expect(
      MiniAppJobRunConflictResponseSchema.safeParse({
        jobId: "job-1",
        status: "pending",
        error: "Dependency still running",
        reason: "dependency_running",
        dependencyId: "dep-1",
      }).success,
    ).toBe(true);
  });

  test("GET /api/jobs/list shape", () => {
    expect(
      MiniAppJobsListResponseSchema.safeParse({
        jobs: [
          {
            id: "job-1",
            name: "Daily sync",
            type: "python",
            status: "completed",
            lastRunAt: "2026-08-18T11:00:00.000Z",
          },
        ],
        count: 1,
      }).success,
    ).toBe(true);
  });

  test("GET /api/jobs/status/:jobId shape", () => {
    expect(
      MiniAppJobStatusResponseSchema.safeParse({
        id: "job-1",
        name: "Daily sync",
        type: "python",
        status: "failed",
        error: "timeout",
      }).success,
    ).toBe(true);
  });

  test("documented request bodies remain valid", () => {
    expect(
      MiniAppDbWriteRequestSchema.safeParse({
        appId: "app-1",
        sql: "INSERT INTO t (x) VALUES (?)",
        params: [1],
      }).success,
    ).toBe(true);
    expect(
      MiniAppDbWriteBatchRequestSchema.safeParse({
        appId: "app-1",
        statements: [
          { sql: "INSERT INTO t (x) VALUES (?)", params: [1] },
          { sourceId: "primary", sql: "UPDATE t SET x = ? WHERE id = ?", params: [2, 1] },
        ],
      }).success,
    ).toBe(true);
    expect(
      MiniAppJobRunRequestSchema.safeParse({
        jobId: "job-1",
        wait: true,
        params: { THREAD_ID: "abc" },
      }).success,
    ).toBe(true);
  });

  test("rejects breaking changes to success literals", () => {
    expect(
      MiniAppJobRunAsyncResponseSchema.safeParse({
        jobId: "job-1",
        status: "pending",
      }).success,
    ).toBe(false);
    expect(
      MiniAppDbExecResponseSchema.safeParse({ success: false }).success,
    ).toBe(false);
  });
});
