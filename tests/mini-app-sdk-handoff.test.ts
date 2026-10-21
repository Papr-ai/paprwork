import { describe, expect, it } from "vitest";
import { createHandoffChannel } from "../src/resources/mini-app-sdk/papr-handoff.js";

function fakeWin() {
  const parent = {} as Window;
  let handler: ((e: MessageEvent) => void) | null = null;
  const win = {
    parent,
    addEventListener: (_t: string, fn: (e: MessageEvent) => void) => (handler = fn),
  } as unknown as Pick<Window, "addEventListener" | "parent">;
  const post = (data: unknown, source: unknown = parent) => handler?.({ data, source } as MessageEvent);
  return { win, post };
}

describe("papr.onHandoff", () => {
  it("fires once per hand-off (retries share a nonce) with the card's view", () => {
    const { win, post } = fakeWin();
    const ch = createHandoffChannel(win);
    const got: unknown[] = [];
    ch.onHandoff((h) => void got.push(h.view));
    const msg = { type: "papr-handoff", nonce: "n1", view: "outreach:c_123", source: "claude" };
    post(msg);
    post(msg);
    expect(got).toEqual(["outreach:c_123"]);
  });

  it("ignores messages that aren't from the Papr window or aren't hand-offs", () => {
    const { win, post } = fakeWin();
    const ch = createHandoffChannel(win);
    const got: unknown[] = [];
    ch.onHandoff((h) => void got.push(h));
    post({ type: "papr-handoff", nonce: "n2", view: "x" }, {} as Window);
    post({ type: "other", nonce: "n3" });
    expect(got).toEqual([]);
  });

  it("replays a fresh hand-off to a listener registered after it arrived (app still booting)", () => {
    const { win, post } = fakeWin();
    let t = 1_000;
    const ch = createHandoffChannel(win, () => t);
    post({ type: "papr-handoff", nonce: "n4", view: "outreach:c_9" });
    const late: unknown[] = [];
    ch.onHandoff((h) => void late.push(h.view));
    expect(late).toEqual(["outreach:c_9"]);
    t += 120_000;
    const stale: unknown[] = [];
    ch.onHandoff((h) => void stale.push(h.view));
    expect(stale).toEqual([]);
  });
});
