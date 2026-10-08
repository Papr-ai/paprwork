import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __flushTursoChangedPingForTests,
  __pendingTursoChangedForTests,
  __setTursoChangedSenderForTests,
  noteTursoDatabaseChanged,
} from "../src/gateway/services/tursoReplica/creditTursoChangedPing.js";

describe("credit Turso changed ping", () => {
  afterEach(() => {
    __setTursoChangedSenderForTests(null);
    __flushTursoChangedPingForTests();
    delete process.env.PAPR_CREDITS_TURSO_PING;
  });

  it("coalesces pushes into one request with every database", async () => {
    const sent: string[][] = [];
    __setTursoChangedSenderForTests(async (names) => {
      sent.push(names);
    });
    noteTursoDatabaseChanged("d-aaaa");
    noteTursoDatabaseChanged("d-bbbb");
    noteTursoDatabaseChanged("d-aaaa");
    noteTursoDatabaseChanged(null);
    expect(__pendingTursoChangedForTests().sort()).toEqual(["d-aaaa", "d-bbbb"]);
    __flushTursoChangedPingForTests();
    expect(sent).toEqual([["d-aaaa", "d-bbbb"]]);
    expect(__pendingTursoChangedForTests()).toEqual([]);
  });

  it("never throws when the server is unreachable", async () => {
    const fail = vi.fn(async () => {
      throw new Error("offline");
    });
    __setTursoChangedSenderForTests(fail);
    noteTursoDatabaseChanged("d-cccc");
    expect(() => __flushTursoChangedPingForTests()).not.toThrow();
    await Promise.resolve();
    expect(fail).toHaveBeenCalledOnce();
  });

  it("can be switched off", () => {
    process.env.PAPR_CREDITS_TURSO_PING = "0";
    noteTursoDatabaseChanged("d-dddd");
    expect(__pendingTursoChangedForTests()).toEqual([]);
  });
});
