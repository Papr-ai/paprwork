import { describe, expect, it } from "vitest";
import {
  buildReplicaSchemaDriftFailureError,
  httpStatusForMiniAppDbQueryError,
  isReplicaSchemaMismatchUserError,
} from "../src/gateway/services/tursoReplica/replicaSchemaQueryErrorMessage.js";

describe("replicaSchemaQueryErrorMessage", () => {
  it("detects schema mismatch prefix", () => {
    expect(
      isReplicaSchemaMismatchUserError(
        "Schema mismatch for gtm: no such column: client_name",
      ),
    ).toBe(true);
    expect(
      isReplicaSchemaMismatchUserError(
        "Schema update pending for gtm. Local replica is catching up",
      ),
    ).toBe(false);
  });

  it("reports confirmed mismatch when Turso primary has the same schema error", () => {
    const err = buildReplicaSchemaDriftFailureError({
      sourceLabel: "gtm",
      localMessage: "prepare failed: Parse error: no such column: client_name",
      healMessage: "prepare failed: Parse error: no such column: client_name",
      primaryMessage:
        "SQL_INPUT_ERROR: SQLite input error: no such column: client_name (at offset 7)",
    });
    expect(err.message).toContain("Schema mismatch for gtm");
    expect(err.message).toContain("client_name");
    expect(err.message).toContain("not replica catch-up");
    expect(err.message).toContain("papr_db_apply_migration");
  });

  it("keeps transient wording with local detail when primary is unavailable", () => {
    const err = buildReplicaSchemaDriftFailureError({
      sourceLabel: "gtm",
      localMessage: "no such column: foo",
      primaryUnavailable: true,
    });
    expect(err.message).toContain("Schema update pending");
    expect(err.message).toContain("Original:");
    expect(err.message).toContain("foo");
    expect(err.message).not.toContain("Schema mismatch");
  });

  it("maps confirmed schema mismatch to HTTP 500 and transient pending to 503", () => {
    expect(
      httpStatusForMiniAppDbQueryError(
        "Schema mismatch for gtm: no such column: client_name",
      ),
    ).toBe(500);
    expect(
      httpStatusForMiniAppDbQueryError(
        "Schema update pending for gtm. Local replica is catching up",
      ),
    ).toBe(503);
  });

  it("includes primary non-schema failure when verification did not confirm mismatch", () => {
    const err = buildReplicaSchemaDriftFailureError({
      sourceLabel: "gtm",
      localMessage: "no such table: missing",
      primaryMessage: "network timeout",
    });
    expect(err.message).toContain("Schema update pending");
    expect(err.message).toContain("Local:");
    expect(err.message).toContain("Turso primary: network timeout");
  });
});
