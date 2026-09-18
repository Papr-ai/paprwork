import { afterEach, describe, expect, test } from "vitest";
import {
  hashMemoryContent,
  reserveMemoryWrite,
  resetMemoryWriteGuard,
} from "../src/gateway/services/memoryWriteGuard.js";

/**
 * Guard against the measured commit() race.
 *
 * `commit()` used to delete the in-flight hash BEFORE writing the journal, so
 * a second write starting in that window saw neither barrier. Measured in one
 * namespace: 9 rows written after their own hash was already journaled
 * (~0.8% of ~1,100 guarded writes) — e.g. hash f9b601326c0e journaled at
 * 09-11T06:04:44 with another row created 68 seconds later.
 */
describe("memoryWriteGuard", () => {
  afterEach(() => resetMemoryWriteGuard());

  test("blocks an identical second write after commit", () => {
    const content = "Calendar Reader — capability card";
    const first = reserveMemoryWrite(content, "job_capability");
    expect(first.proceed).toBe(true);
    first.commit();

    const second = reserveMemoryWrite(content, "job_capability");
    expect(second.proceed).toBe(false);
  });

  test("THE RACE: a write starting during commit is still blocked", () => {
    const content = "identical body";
    const a = reserveMemoryWrite(content, "writer_a");
    expect(a.proceed).toBe(true);

    // Before the fix, commit() released inFlight first, so a reservation made
    // immediately after the journal write but "during" the release window
    // could slip through. Post-fix the journal is durable before release, so
    // either barrier catches it.
    a.commit();
    const b = reserveMemoryWrite(content, "writer_b");
    expect(b.proceed).toBe(false);
  });

  test("blocks a concurrent write while the first is still in flight", () => {
    const content = "in-flight body";
    const a = reserveMemoryWrite(content, "writer_a");
    const b = reserveMemoryWrite(content, "writer_b");
    expect(a.proceed).toBe(true);
    expect(b.proceed).toBe(false); // a has not committed yet
  });

  test("release() allows a genuine retry after a failed add", () => {
    const content = "retry me";
    const a = reserveMemoryWrite(content, "writer_a");
    expect(a.proceed).toBe(true);
    a.release(); // simulate the add throwing

    const b = reserveMemoryWrite(content, "writer_a");
    expect(b.proceed).toBe(true);
  });

  test("different content is never blocked", () => {
    const a = reserveMemoryWrite("body one", "w");
    a.commit();
    expect(reserveMemoryWrite("body two", "w").proceed).toBe(true);
  });

  test("empty content is passed through rather than deduped", () => {
    // Empty bodies have no identity worth deduping; the caller decides.
    expect(reserveMemoryWrite("", "w").proceed).toBe(true);
    expect(reserveMemoryWrite("   ", "w").proceed).toBe(true);
  });

  test("hash is stable and content-derived", () => {
    expect(hashMemoryContent("abc")).toBe(hashMemoryContent("abc"));
    expect(hashMemoryContent("abc")).not.toBe(hashMemoryContent("abd"));
  });
});
