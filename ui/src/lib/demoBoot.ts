/**
 * demoBoot — installs mock Electron bridges for the web demo build.
 *
 * Imported first from index.tsx; does nothing unless VITE_DEMO_MODE === "1".
 * Provides window.electronAPI / window.paprAPI as a deep proxy: any method
 * call resolves to a benign value, any on*() listener returns an unsubscribe.
 * Known namespaces (gateway supervisor, ollama) get concrete fixtures.
 */

type AnyFn = (...args: unknown[]) => unknown;

/** Concrete fixtures for calls whose result shape matters */
const OVERRIDES: Record<string, AnyFn> = {
  "gateway.getStatus": () => Promise.resolve({ status: "running" }),
  "gateway.onStatusChange": (cb) => {
    (cb as AnyFn)({ status: "running" });
    return () => {};
  },
  "gateway.removeStatusListener": () => {},
  "ollama.checkStatus": () =>
    Promise.resolve({
      success: true,
      isRunning: true,
      // Every model reads as installed — skips first-time-setup banner
      models: new Proxy([] as string[], {
        get: (t, p) =>
          p === "includes" ? () => true : Reflect.get(t, p),
      }),
    }),
  "ollama.ensureModel": () => Promise.resolve({ success: true }),
  "ollama.hasModel": () => Promise.resolve(true),
  "ollama.listModels": () => Promise.resolve([]),
  "getAppVersion": () => Promise.resolve("demo"),
};

function makeDeepMock(path: string[]): unknown {
  const fn = (..._args: unknown[]): unknown => {
    const name = path[path.length - 1] ?? "";
    if (/^(on|subscribe|addListener)/.test(name)) return () => {};
    if (/list|all$/i.test(name)) return Promise.resolve([]);
    // Objects, not null: callers read properties (.connected, .status, …)
    if (/^(get|read|fetch|query|check)/i.test(name)) return Promise.resolve({});
    return Promise.resolve({ success: true });
  };
  return new Proxy(fn, {
    get(_t, prop: string | symbol) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      const next = [...path, String(prop)];
      const key = next.slice(1).join(".");
      if (OVERRIDES[key]) return OVERRIDES[key];
      return makeDeepMock(next);
    },
  });
}

export function installDemoBridges(): void {
  if (import.meta.env.VITE_DEMO_MODE !== "1") return;
  const w = window as unknown as Record<string, unknown>;
  if (!w.electronAPI) w.electronAPI = makeDeepMock(["electronAPI"]);
  if (!w.paprAPI) w.paprAPI = makeDeepMock(["paprAPI"]);
  // Mark demo mode for any UI code that wants to adapt copy
  w.__PAPR_DEMO__ = true;
}

installDemoBridges();
