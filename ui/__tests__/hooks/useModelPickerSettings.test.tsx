/**
 * `pickerModels` must keep the same identity across renders.
 *
 * It is a dependency of effects in ChatContainer. When it was rebuilt inline
 * on every render, those effects re-ran on every render — survivable only for
 * as long as every one of them happened to bail out without setting state. One
 * that did not (`setModelSettings`, fed a freshly-read object that never
 * compares equal) turned that into "Maximum update depth exceeded" and took
 * the whole app down with it, draft message included.
 *
 * This is the behavioural half of the guard; `tests/render-loop-invariants.ts`
 * pins the shape of the code.
 */

import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();

vi.mock("../../src/lib/gateway", () => ({
  gateway: {
    send: (...args: unknown[]) => send(...args),
  },
}));

import { useModelPickerSettings } from "../../hooks/useModelPickerSettings";

describe("useModelPickerSettings", () => {
  beforeEach(() => {
    send.mockReset();
    // No stored preference: the hook falls back to curated defaults.
    send.mockResolvedValue({ success: true, data: { uiPreferences: {} } });
  });

  it("returns the same pickerModels array across re-renders", async () => {
    const { result, rerender } = renderHook(() => useModelPickerSettings());

    // Let the initial settings load settle so identity is compared in the
    // steady state the chat pane actually renders in.
    await act(async () => {
      await Promise.resolve();
    });

    const first = result.current.pickerModels;
    rerender();
    rerender();
    rerender();

    expect(result.current.pickerModels).toBe(first);
  });

  it("returns a non-empty model list", () => {
    const { result } = renderHook(() => useModelPickerSettings());
    expect(result.current.pickerModels.length).toBeGreaterThan(0);
  });

  it("gives a new array only when the enabled set actually changes", async () => {
    const { result } = renderHook(() => useModelPickerSettings());

    await act(async () => {
      await Promise.resolve();
    });

    const before = result.current.pickerModels;

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("papr:picker-models-updated", {
          detail: { enabledPickerModelIds: ["claude-sonnet-5"] },
        }),
      );
    });

    expect(result.current.pickerModels).not.toBe(before);
    expect(result.current.pickerModels.map((m) => m.id)).toEqual([
      "claude-sonnet-5",
    ]);
  });
});
