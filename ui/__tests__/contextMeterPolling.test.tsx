import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContextMeter } from "../components/Chat/ContextMeter";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/lib/gateway", () => ({ gateway: { send } }));
vi.mock("../components/Chat/ContextUsagePanel", () => ({ ContextUsagePanel: () => null }));
vi.mock("../components/Chat/ContextMeterRing", () => ({ ContextMeterRing: () => null }));

afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

it("bounds polling during a slow read and refreshes after streaming stops", async () => {
  vi.useFakeTimers();
  let resolve!: (value: unknown) => void;
  send.mockImplementation(() => new Promise(r => { resolve = r; }));
  const props = { chatId: "a", model: "test", contextLimit: 100, isSending: true, onOpenFullInspector: vi.fn() };
  const view = render(<ContextMeter {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(send).toHaveBeenCalledTimes(1);
  view.rerender(<ContextMeter {...props} isSending={false} />);
  await act(async () => { resolve({data: null}); });
  expect(send).toHaveBeenCalledTimes(2);
  await act(async () => { resolve({data: null}); await vi.advanceTimersByTimeAsync(10000); });
  expect(send).toHaveBeenCalledTimes(2);
});

it("ignores a late reply after switching chats and requests the new chat", async () => {
  let resolve!: (value: unknown) => void;
  send.mockImplementation(() => new Promise(r => { resolve = r; }));
  const props = { chatId: "a", model: "test", contextLimit: 100, isSending: false, onOpenFullInspector: vi.fn() };
  const view = render(<ContextMeter {...props} />);
  await act(async () => {});
  view.rerender(<ContextMeter {...props} chatId="b" />);
  await act(async () => { resolve({data: {model: "old", effectiveWindow: 100, usedTokens: 80, lastTurn: null, totals: {}}}); });
  expect(view.queryByRole("button")).toBeNull();
  expect(send).toHaveBeenLastCalledWith("chat:context-meter", expect.objectContaining({chatId: "b"}));
});
