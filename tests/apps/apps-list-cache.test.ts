import { beforeEach, describe, expect, it } from "vitest";
import { readAppsListCache, writeAppsListCache } from "../../ui/utils/appsListCache";
import type { Artifact } from "../../ui/stores/artifactsStore";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const app = (id: string) => ({ id, type: "app", title: id }) as unknown as Artifact;

describe("apps list cache", () => {
  beforeEach(() => store.clear());
  it("round-trips per workspace and keeps only apps", () => {
    writeAppsListCache("o:n1", [app("a"), { id: "d", type: "document" } as unknown as Artifact]);
    expect(readAppsListCache("o:n1")?.map((a) => a.id)).toEqual(["a"]);
    expect(readAppsListCache("o:n2")).toBeNull();
  });
  it("cold launch (no workspace yet) reads the last written workspace", () => {
    writeAppsListCache("o:n1", [app("a")]);
    writeAppsListCache("o:n2", [app("b")]);
    expect(readAppsListCache(null)?.map((a) => a.id)).toEqual(["b"]);
  });
  it("never writes without a workspace and ignores empty lists", () => {
    writeAppsListCache(null, [app("a")]);
    expect(readAppsListCache(null)).toBeNull();
    writeAppsListCache("o:n1", []);
    expect(readAppsListCache("o:n1")).toBeNull();
  });
});
