import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { ensureUserPath, mergeLoginShellPath, mergePath, parseShellPath } = require("./userPath.cjs") as {
  ensureUserPath: (o: Record<string, unknown>) => string;
  mergeLoginShellPath: (o: Record<string, unknown>) => Promise<string | null>;
  mergePath: (a: string, b: string[]) => string;
  parseShellPath: (s: string) => string | null;
};

const LAUNCHD = "/usr/bin:/bin:/usr/sbin:/sbin";

describe("ensureUserPath", () => {
  it("adds Homebrew dirs that exist to a launchd PATH, keeping system dirs first", () => {
    const env: Record<string, string> = { PATH: LAUNCHD };
    const exists = (d: string) => d === "/opt/homebrew/bin" || d === "/usr/local/bin";
    ensureUserPath({ platform: "darwin", env, home: "/Users/x", exists });
    expect(env.PATH).toBe(`${LAUNCHD}:/opt/homebrew/bin:/usr/local/bin`);
  });

  it("skips dirs that do not exist and is idempotent", () => {
    const env: Record<string, string> = { PATH: LAUNCHD };
    ensureUserPath({ platform: "darwin", env, home: "/Users/x", exists: () => false });
    expect(env.PATH).toBe(LAUNCHD);
    const all = () => true;
    ensureUserPath({ platform: "darwin", env, home: "/Users/x", exists: all });
    const once = env.PATH;
    ensureUserPath({ platform: "darwin", env, home: "/Users/x", exists: all });
    expect(env.PATH).toBe(once);
  });

  it("leaves Windows PATH alone", () => {
    const env: Record<string, string> = { PATH: "C:\\Windows" };
    ensureUserPath({ platform: "win32", env, home: "C:\\Users\\x", exists: () => true });
    expect(env.PATH).toBe("C:\\Windows");
  });
});

describe("login shell PATH", () => {
  it("parses PATH out of noisy rc output", () => {
    expect(parseShellPath("hello\n__PAPR_PATH__/a:/b__PAPR_PATH__\nbye")).toBe("/a:/b");
    expect(parseShellPath("no markers")).toBeNull();
  });

  it("puts the user's shell order first and dedupes", () => {
    expect(mergePath("/opt/homebrew/bin:/usr/bin", [LAUNCHD, "/x"].join(":").split(":"))).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/x",
    );
  });

  it("merges a successful shell read into env.PATH", async () => {
    const env: Record<string, string> = { PATH: LAUNCHD, SHELL: "/bin/zsh" };
    const run = (_s: string, _a: string[], _o: unknown, cb: (e: null, out: string) => void) =>
      cb(null, "__PAPR_PATH__/opt/homebrew/bin:/usr/bin__PAPR_PATH__");
    await mergeLoginShellPath({ platform: "darwin", env, run });
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("keeps PATH unchanged on error, timeout, or an unsupported shell", async () => {
    const env: Record<string, string> = { PATH: LAUNCHD, SHELL: "/bin/zsh" };
    const fail = (_s: string, _a: string[], _o: unknown, cb: (e: Error, out: string) => void) => cb(new Error("timeout"), "");
    expect(await mergeLoginShellPath({ platform: "darwin", env, run: fail })).toBeNull();
    expect(env.PATH).toBe(LAUNCHD);
    const fish: Record<string, string> = { PATH: LAUNCHD, SHELL: "/opt/homebrew/bin/fish" };
    expect(await mergeLoginShellPath({ platform: "darwin", env: fish })).toBeNull();
  });

  it("works against a real login shell (guards the ${PATH} quoting)", async () => {
    const env: Record<string, string> = { PATH: LAUNCHD, SHELL: "/bin/sh", HOME: "/tmp" };
    const merged = await mergeLoginShellPath({ platform: "darwin", env, timeoutMs: 10000 });
    expect(merged).toContain("/usr/bin");
    expect(merged).not.toContain("__PAPR_PATH__");
  });
});
