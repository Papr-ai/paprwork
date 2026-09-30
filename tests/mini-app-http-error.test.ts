import { describe, expect, it } from "vitest";
import {
  formatMiniAppHttpErrorMessage,
  normalizeMiniAppRuntimeErrorMessage,
  parseApiErrorFromResponseBody,
  shouldShowDataSourcesMigrationHint,
} from "../src/core/utils/miniAppHttpError.js";

describe("miniAppHttpError", () => {
  it("parses JSON error field from response body", () => {
    expect(
      parseApiErrorFromResponseBody(
        '{"error":"sync engine operation failed: short read on WAL"}',
      ),
    ).toBe("sync engine operation failed: short read on WAL");
  });

  it("formats request failed with status and server message", () => {
    const wal =
      "sync engine operation failed: database error: I/O error: short read on WAL frame at offset 32: expected 4096 bytes, got 0";
    expect(
      formatMiniAppHttpErrorMessage(500, JSON.stringify({ error: wal }), "/api/db/query"),
    ).toBe(`Request failed (500): ${wal}`);
  });

  it("surfaces missing table errors without data-sources hint", () => {
    const msg = formatMiniAppHttpErrorMessage(
      500,
      '{"error":"SQLITE_UNKNOWN: SQLite error: no such table: leads"}',
      "/api/db/query",
    );
    expect(msg).toContain("no such table");
    expect(shouldShowDataSourcesMigrationHint(msg)).toBe(false);
  });

  it("formats job 404 with actionable copy", () => {
    const msg = formatMiniAppHttpErrorMessage(
      404,
      '{"error":"Job not found: abc-123"}',
      "/api/jobs/run",
    );
    expect(msg).toContain("Job not found");
    expect(shouldShowDataSourcesMigrationHint(msg)).toBe(false);
  });

  it("shows data-sources hint only for link/path problems", () => {
    expect(
      shouldShowDataSourcesMigrationHint("No data sources linked for app x"),
    ).toBe(true);
    expect(
      shouldShowDataSourcesMigrationHint(
        "Request failed (503): Local database not found at /old/path/db.sqlite",
      ),
    ).toBe(true);
    expect(
      shouldShowDataSourcesMigrationHint(
        "Request failed (500): sync engine operation failed: WAL",
      ),
    ).toBe(false);
  });

  it("normalizes empty unhandled rejection messages", () => {
    expect(normalizeMiniAppRuntimeErrorMessage("Unhandled rejection:")).toContain(
      "no error details",
    );
    expect(
      normalizeMiniAppRuntimeErrorMessage(
        "Unhandled rejection: Request failed (404): Job not found: x",
      ),
    ).toBe("Request failed (404): Job not found: x");
  });
});
