import { describe, expect, it } from "vitest";

import {
  assertNoEngineOwnedTableWrite,
  findEngineOwnedTableReference,
  isEngineOwnedTableName,
} from "../src/gateway/services/appRuntime/engineOwnedTables.js";
import {
  assertExecSql,
  assertReadOnlySql,
  assertWriteSql,
} from "../src/gateway/services/appRuntime/sqlValidation.js";

/**
 * The statement that aborted the sync worker on 2026-09-10. It is a well-formed
 * `CREATE TABLE IF NOT EXISTS`, so the statement-kind guard admitted it, and it
 * declares no PRIMARY KEY — leaving the engine to seek an index that is not there.
 */
const CRASHING_CREATE =
  'CREATE TABLE IF NOT EXISTS "turso_sync_last_change_id" ' +
  '("client_id" TEXT, "pull_gen" TEXT, "change_id" TEXT)';

describe("isEngineOwnedTableName", () => {
  it("claims the engine's private tables", () => {
    expect(isEngineOwnedTableName("turso_cdc")).toBe(true);
    expect(isEngineOwnedTableName("turso_cdc_version")).toBe(true);
    expect(isEngineOwnedTableName("turso_sync_last_change_id")).toBe(true);
    expect(isEngineOwnedTableName("turso_sync_state")).toBe(true);
  });

  it("claims our sync infra and SQLite internals", () => {
    expect(isEngineOwnedTableName("_papr_sync_log")).toBe(true);
    expect(isEngineOwnedTableName("_papr_sync_meta")).toBe(true);
    expect(isEngineOwnedTableName("sqlite_master")).toBe(true);
    expect(isEngineOwnedTableName("sqlite_sequence")).toBe(true);
  });

  it("leaves ordinary app tables alone", () => {
    expect(isEngineOwnedTableName("books")).toBe(false);
    expect(isEngineOwnedTableName("reading_sessions")).toBe(false);
    // Scoped narrowly on purpose: not every `turso`-ish name is the engine's.
    expect(isEngineOwnedTableName("tursophile_notes")).toBe(false);
    expect(isEngineOwnedTableName("papr_books")).toBe(false);
  });

  it("sees through each quoting style", () => {
    expect(isEngineOwnedTableName('"turso_cdc"')).toBe(true);
    expect(isEngineOwnedTableName("`turso_cdc`")).toBe(true);
    expect(isEngineOwnedTableName("[turso_cdc]")).toBe(true);
    expect(isEngineOwnedTableName("  TURSO_CDC  ")).toBe(true);
  });
});

describe("assertNoEngineOwnedTableWrite", () => {
  it("rejects the statement that caused the abort", () => {
    expect(() => assertNoEngineOwnedTableWrite(CRASHING_CREATE)).toThrow(
      /managed by the sync engine/,
    );
    expect(findEngineOwnedTableReference(CRASHING_CREATE)).toBe(
      "turso_sync_last_change_id",
    );
  });

  it("tags the refusal 403 so existing route handling reports it unchanged", () => {
    try {
      assertNoEngineOwnedTableWrite(CRASHING_CREATE);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as { status?: number }).status).toBe(403);
    }
  });

  it("rejects DML against engine bookkeeping", () => {
    expect(() =>
      assertNoEngineOwnedTableWrite("DELETE FROM turso_sync_last_change_id"),
    ).toThrow(/managed by the sync engine/);
    expect(() =>
      assertNoEngineOwnedTableWrite(
        "UPDATE turso_sync_last_change_id SET change_id = 'not-an-integer'",
      ),
    ).toThrow(/managed by the sync engine/);
    expect(() =>
      assertNoEngineOwnedTableWrite("INSERT INTO turso_cdc VALUES (1, 2, 3)"),
    ).toThrow(/managed by the sync engine/);
    expect(() =>
      assertNoEngineOwnedTableWrite("DELETE FROM _papr_sync_log"),
    ).toThrow(/managed by the sync engine/);
  });

  it("is not evaded by quoting or schema qualification", () => {
    expect(() =>
      assertNoEngineOwnedTableWrite('DELETE FROM "turso_cdc"'),
    ).toThrow(/managed by the sync engine/);
    expect(() =>
      assertNoEngineOwnedTableWrite("DELETE FROM main.`turso_cdc`"),
    ).toThrow(/managed by the sync engine/);
    expect(() =>
      assertNoEngineOwnedTableWrite("DELETE FROM [turso_cdc]"),
    ).toThrow(/managed by the sync engine/);
    expect(() =>
      assertNoEngineOwnedTableWrite("delete from TURSO_CDC"),
    ).toThrow(/managed by the sync engine/);
  });

  it("catches a reference that is not the leading table", () => {
    // Scanning the whole statement is what makes the indirect forms reachable.
    expect(() =>
      assertNoEngineOwnedTableWrite(
        "INSERT INTO books(id) SELECT change_id FROM turso_sync_last_change_id",
      ),
    ).toThrow(/managed by the sync engine/);
    expect(() =>
      assertNoEngineOwnedTableWrite(
        "UPDATE books SET n = (SELECT count(*) FROM turso_cdc)",
      ),
    ).toThrow(/managed by the sync engine/);
  });

  it("allows ordinary app writes", () => {
    expect(() =>
      assertNoEngineOwnedTableWrite(
        "INSERT INTO books(title, author) VALUES (?, ?)",
      ),
    ).not.toThrow();
    expect(() =>
      assertNoEngineOwnedTableWrite("UPDATE reading_sessions SET pages = ?"),
    ).not.toThrow();
    expect(() =>
      assertNoEngineOwnedTableWrite(
        "CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, title TEXT)",
      ),
    ).not.toThrow();
  });

  it("does not mistake app data for a table reference", () => {
    // A reserved name inside a string literal is content, not a reference. Without
    // literal stripping this guard would reject legitimate writes.
    expect(() =>
      assertNoEngineOwnedTableWrite(
        "INSERT INTO notes(body) VALUES ('see turso_cdc for details')",
      ),
    ).not.toThrow();
    expect(() =>
      assertNoEngineOwnedTableWrite(
        "INSERT INTO notes(body) VALUES ('it''s about _papr_sync_log')",
      ),
    ).not.toThrow();
  });

  it("does not let a comment hide a reference", () => {
    expect(() =>
      assertNoEngineOwnedTableWrite(
        "DELETE FROM books -- harmless\nINSERT INTO turso_cdc VALUES (1)",
      ),
    ).toThrow(/managed by the sync engine/);
    expect(() =>
      assertNoEngineOwnedTableWrite(
        "INSERT INTO books(id) /* turso_cdc */ VALUES (1)",
      ),
    ).not.toThrow();
  });
});

describe("sqlValidation keeps its kind guards and gains the name guard", () => {
  it("still enforces statement kind", () => {
    expect(() => assertWriteSql("SELECT 1")).toThrow(/Only INSERT, UPDATE/);
    expect(() => assertReadOnlySql("DELETE FROM books")).toThrow(
      /Only SELECT/,
    );
    expect(() => assertExecSql("DROP TABLE books")).toThrow(
      /Only CREATE TABLE IF NOT EXISTS/,
    );
  });

  it("now also refuses engine-owned targets on write and exec", () => {
    expect(() => assertWriteSql("DELETE FROM turso_sync_last_change_id")).toThrow(
      /managed by the sync engine/,
    );
    expect(() => assertExecSql(CRASHING_CREATE)).toThrow(
      /managed by the sync engine/,
    );
  });

  it("leaves reads unguarded — reading these tables cannot wedge the engine", () => {
    expect(() =>
      assertReadOnlySql("SELECT name FROM sqlite_master WHERE type='table'"),
    ).not.toThrow();
    expect(() =>
      assertReadOnlySql("SELECT * FROM turso_cdc LIMIT 1"),
    ).not.toThrow();
  });

  it("admits ordinary app statements on every route", () => {
    expect(() => assertWriteSql("INSERT INTO books(id) VALUES (?)")).not.toThrow();
    expect(() =>
      assertExecSql("CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY)"),
    ).not.toThrow();
    expect(() => assertReadOnlySql("SELECT * FROM books")).not.toThrow();
  });
});
