import { describe, expect, it } from "vitest";
import {
  buildProposeFailureAgentPrompt,
  describeProposeError,
  migrationLabel,
  shorten,
} from "../utils/proposeErrorDisplay";

// Exact text from v2.7.6 (Trivalence SPICED Academy, Publish now).
const NEVER_RAN =
  "These migration files never ran on this copy's database: " +
  "databases/trivalence-spiced-academy/migrations/0012_20261104145839_certification.sql. " +
  "Apply them (papr_db_apply_migration) and test, or remove them, then propose again.";

describe("describeProposeError", () => {
  it("explains an unapplied migration in plain words and keeps the full text", () => {
    const out = describeProposeError(NEVER_RAN);
    expect(out.message).toContain("(certification)");
    expect(out.message).not.toMatch(/papr_db|\.sql|migrations\//);
    expect(out.detail).toBe(NEVER_RAN);
    expect(out.fixableByPen).toBe(true);
  });

  it("lists several migrations by name", () => {
    const out = describeProposeError(
      "These migration files never ran on this copy's database: a/migrations/0012_x.sql, a/migrations/0013_20261104145839_y.sql. Apply them (…)",
    );
    expect(out.message).toContain("(x, y)");
  });

  it("never cuts a long message mid-word", () => {
    const long = "word ".repeat(80) + "end";
    const out = describeProposeError(long);
    expect(out.message.endsWith("word…")).toBe(true);
    expect(out.detail).toBe(long.trim());
  });

  it("short unknown errors show as-is with no details", () => {
    expect(describeProposeError("Nothing to send")).toEqual({ message: "Nothing to send", fixableByPen: true });
  });
});

describe("helpers", () => {
  it("migrationLabel strips number and timestamp", () => {
    expect(migrationLabel("x/0012_20261104145839_certification.sql")).toBe("certification");
    expect(migrationLabel("0003_add_notes.sql")).toBe("add_notes");
  });
  it("shorten leaves short text alone", () => {
    expect(shorten("  a  b ")).toBe("a b");
  });
});

describe("buildProposeFailureAgentPrompt", () => {
  it("carries the full error and the migration fix steps", () => {
    const p = buildProposeFailureAgentPrompt({ appId: "app-1", appTitle: "SPICED", error: NEVER_RAN, publishNow: true });
    expect(p).toContain("app-1");
    expect(p).toContain("0012_20261104145839_certification.sql");
    expect(p).toContain("papr_db_apply_migration");
    expect(p).toContain("publishNow: true");
  });
  it("falls back to diagnosis for other errors", () => {
    const p = buildProposeFailureAgentPrompt({ appId: "a", error: "git push failed", publishNow: false });
    expect(p).toContain("get_cloud_sync_status");
    expect(p).not.toContain("publishNow");
  });
});
