import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapBudgetExhausted,
  clearBootstrapBudget,
  noteBootstrapStarted,
  recentBootstrapCount,
} from "../../../src/gateway/services/tursoReplica/tursoReplicaBootstrapMarker.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
const db = path.join(dir, "data.db");
afterEach(() => clearBootstrapBudget(db));

describe("replica bootstrap daily budget", () => {
  it("parks after 4 full downloads in 24h, survives marker resets", () => {
    const t0 = 1_000_000_000;
    for (let i = 0; i < 4; i++) noteBootstrapStarted(db, t0 + i * 15 * 60_000);
    expect(recentBootstrapCount(db, t0 + 3_600_000)).toBe(4);
    expect(bootstrapBudgetExhausted(db, t0 + 3_600_000)).toBe(true);
  });

  it("counts opens within a minute as one attempt", () => {
    const t0 = 2_000_000_000;
    for (let i = 0; i < 10; i++) noteBootstrapStarted(db, t0 + i * 1_000);
    expect(recentBootstrapCount(db, t0 + 20_000)).toBe(1);
  });

  it("forgets downloads older than 24h and resets on explicit repair", () => {
    const t0 = 3_000_000_000;
    for (let i = 0; i < 4; i++) noteBootstrapStarted(db, t0 + i * 120_000);
    expect(bootstrapBudgetExhausted(db, t0 + 25 * 3_600_000)).toBe(false);
    clearBootstrapBudget(db);
    expect(recentBootstrapCount(db, t0 + 600_000)).toBe(0);
  });
});
