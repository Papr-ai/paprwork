/**
 * Replaces packaged-native-arch.test.ts (which grepped release.yml text).
 * Checks the arch swap itself: each Mac build keeps only its own native
 * binaries, so an x64 .app never ships arm64 libsql/turso and vice versa.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs build script, no types
import { MAC_NATIVE_PACKAGES, ALL_MAC_NATIVE_PACKAGES, scopedPackageName } from "../../scripts/prepare-mac-native-deps.mjs";

type Spec = { install: string[]; remove: string[] };
const specs = MAC_NATIVE_PACKAGES as Record<"arm64" | "x64", Spec>;
const names = (list: string[]) => list.map((s) => scopedPackageName(s) as string);
const other = { arm64: "x64", x64: "arm64" } as const;

describe("prepare-mac-native-deps arch swap", () => {
  it("parses scoped specifiers with and without a version", () => {
    expect(scopedPackageName("@libsql/darwin-arm64@0.4.7")).toBe("@libsql/darwin-arm64");
    expect(scopedPackageName("@libsql/darwin-x64")).toBe("@libsql/darwin-x64");
  });

  for (const arch of ["arm64", "x64"] as const) {
    it(`${arch}: installs only darwin-${arch} packages, pinned to a version`, () => {
      for (const spec of specs[arch].install) {
        expect(spec).toMatch(new RegExp(`darwin-${arch}@\\d`));
      }
    });

    it(`${arch}: removes every native package the ${other[arch]} build installs`, () => {
      const removed = new Set(specs[arch].remove);
      for (const name of names(specs[other[arch]].install)) {
        expect(removed.has(name), name).toBe(true);
      }
    });

    it(`${arch}: never installs and removes the same package`, () => {
      const removed = new Set(specs[arch].remove);
      expect(names(specs[arch].install).filter((n) => removed.has(n))).toEqual([]);
    });
  }

  it("both arches pin the same version of each shared native package", () => {
    const version = (s: string) => s.slice(s.lastIndexOf("@") + 1);
    const base = (s: string) => scopedPackageName(s).replace(/darwin-(arm64|x64)/, "darwin-*");
    const x64 = new Map(specs.x64.install.map((s) => [base(s), version(s)]));
    for (const s of specs.arm64.install) {
      if (x64.has(base(s))) expect(version(s), base(s)).toBe(x64.get(base(s)));
    }
  });

  it("the strip list covers every package either arch touches", () => {
    const all = new Set(ALL_MAC_NATIVE_PACKAGES as string[]);
    for (const arch of ["arm64", "x64"] as const) {
      for (const n of [...names(specs[arch].install), ...specs[arch].remove]) expect(all.has(n), n).toBe(true);
    }
  });
});
