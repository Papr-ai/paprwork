import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, test, vi } from "vitest";

/**
 * Regression: MaxListenersExceededWarning for `papr:organization-changed`.
 * The preload bridge must keep ONE ipcRenderer listener per channel no matter
 * how many components subscribe, and subscribe() must return a disposer.
 */
function loadPapr() {
  const channels = new Map<string, Array<(...a: unknown[]) => void>>();
  const ipcRenderer = {
    on: (ch: string, fn: (...a: unknown[]) => void) => {
      channels.set(ch, [...(channels.get(ch) ?? []), fn]);
    },
    removeListener: vi.fn(),
    invoke: vi.fn(),
    send: vi.fn(),
  };
  let exposed: any;
  const dispatched: string[] = [];
  const req = createRequire(import.meta.url);
  const sandbox: any = {
    require: (m: string) =>
      m === "electron"
        ? {
            contextBridge: { exposeInMainWorld: (_: string, api: unknown) => (exposed = api) },
            ipcRenderer,
            webUtils: {},
          }
        : req(m),
    console: { log() {}, error() {}, warn() {} },
    window: { dispatchEvent: (e: { type: string }) => dispatched.push(e.type) },
    CustomEvent: class { constructor(public type: string, public init?: unknown) {} },
    process,
  };
  const file = path.resolve(__dirname, "../src/electron/preload.cjs");
  vm.runInNewContext(readFileSync(file, "utf8"), sandbox, { filename: file });
  return { papr: exposed.papr, channels, dispatched };
}

describe("preload papr:organization-changed bridge", () => {
  test("registers a single ipcRenderer listener regardless of subscriber count", () => {
    const { papr, channels } = loadPapr();
    for (let i = 0; i < 25; i++) papr.onOrganizationChanged(() => {});
    for (let i = 0; i < 25; i++) papr.onNamespaceChanged(() => {});
    expect(channels.get("papr:organization-changed")).toHaveLength(1);
    expect(channels.get("papr:namespace-changed")).toHaveLength(1);
  });

  test("fans out to every subscriber and dispatches the DOM event once", () => {
    const { papr, channels, dispatched } = loadPapr();
    const a = vi.fn();
    const b = vi.fn();
    papr.onOrganizationChanged(a);
    papr.onOrganizationChanged(b);
    channels.get("papr:organization-changed")![0]({}, { organizationId: "o1" });
    expect(a).toHaveBeenCalledWith({ organizationId: "o1" });
    expect(b).toHaveBeenCalledWith({ organizationId: "o1" });
    expect(dispatched.filter((t) => t === "papr-organization-changed")).toHaveLength(1);
  });

  test("returned disposer and removeOrganizationChangedListener both unsubscribe", () => {
    const { papr, channels } = loadPapr();
    const a = vi.fn();
    const b = vi.fn();
    const dispose = papr.onOrganizationChanged(a);
    papr.onOrganizationChanged(b);
    expect(typeof dispose).toBe("function");
    dispose();
    papr.removeOrganizationChangedListener(b);
    channels.get("papr:organization-changed")![0]({}, { organizationId: "o2" });
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  test("one throwing subscriber does not block the others", () => {
    const { papr, channels } = loadPapr();
    const ok = vi.fn();
    papr.onOrganizationChanged(() => {
      throw new Error("boom");
    });
    papr.onOrganizationChanged(ok);
    channels.get("papr:organization-changed")![0]({}, { organizationId: "o3" });
    expect(ok).toHaveBeenCalled();
  });
});
