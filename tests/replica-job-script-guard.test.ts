import { describe, expect, it } from "vitest";
import {
  scanJobScriptForReplicaSqliteOpens,
  scanShellCommandForReplicaSqliteOpens,
} from "../src/core/utils/replicaJobScriptGuard.js";

describe("replicaJobScriptGuard", () => {
  it("flags sqlite3.connect in python", () => {
    const code = 'import sqlite3\nconn = sqlite3.connect("data.db")';
    const hits = scanJobScriptForReplicaSqliteOpens(code, "py");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toContain("sqlite3.connect");
  });

  it("flags better-sqlite3 in javascript", () => {
    const code = 'const Database = require("better-sqlite3");\nnew Database("data.db");';
    const hits = scanJobScriptForReplicaSqliteOpens(code, "js");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("allows papr_db usage", () => {
    const code = 'from papr_db import connect\nconn = connect()';
    expect(scanJobScriptForReplicaSqliteOpens(code, "py")).toHaveLength(0);
  });

  it("flags inline sqlite3 in shell command", () => {
    const hits = scanShellCommandForReplicaSqliteOpens(
      'python3 -c "import sqlite3; sqlite3.connect(\'data.db\')"',
    );
    expect(hits.length).toBeGreaterThan(0);
  });
});
