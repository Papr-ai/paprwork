import { describe, expect, it, vi } from "vitest";
import {
  coalesceInFlightLocalDbRead,
  resetLocalDbReadCoalesceForTests,
} from "../src/gateway/services/appRuntime/localDbReadCoalesce.js";

describe("localDbReadCoalesce", () => {
  it("runs once for concurrent callers with the same key", async () => {
    resetLocalDbReadCoalesceForTests();
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { rows: [{ id: 1 }] };
    });

    const [a, b, c] = await Promise.all([
      coalesceInFlightLocalDbRead("k1", run),
      coalesceInFlightLocalDbRead("k1", run),
      coalesceInFlightLocalDbRead("k1", run),
    ]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("runs separately for different keys", async () => {
    resetLocalDbReadCoalesceForTests();
    const run = vi.fn(async (n: number) => n);

    const [a, b] = await Promise.all([
      coalesceInFlightLocalDbRead("a", () => run(1)),
      coalesceInFlightLocalDbRead("b", () => run(2)),
    ]);

    expect(run).toHaveBeenCalledTimes(2);
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("allows a new run after the prior promise settles", async () => {
    resetLocalDbReadCoalesceForTests();
    let n = 0;
    const run = vi.fn(async () => ++n);

    expect(await coalesceInFlightLocalDbRead("k", run)).toBe(1);
    expect(await coalesceInFlightLocalDbRead("k", run)).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
