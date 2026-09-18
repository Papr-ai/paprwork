/**
 * Compiled text of a mini-app SDK module, for inlining into preview HTML.
 *
 * Two scripts have to run *before* any app script: the bridge (installs
 * `window.paprAPI`, so an app calling it during parse does not get undefined —
 * CLAUDE.md Issue 16) and the preview fetch gate (wraps `window.fetch`, so an
 * app that captures a reference during parse captures the wrapped one).
 *
 * Referencing them by URL cannot satisfy that cheaply:
 *
 * - `async defer` runs them *after* parsing, which is too late for both. It was
 *   added in #155 to stop a missing module blocking load for ~11 seconds, but
 *   it fixes the slow case by making the broken case silent — a gate that never
 *   installs is the CPU pathology this whole change exists to remove.
 * - Blocking `<script src>` is correct but costs a round trip before first
 *   paint, and under per-app origins the URL differs per app, so the HTTP cache
 *   cannot share one copy between them. Every app pays it on every cold start.
 *
 * Inlining is correct *and* free: the bytes are already in the HTML response,
 * so there is no request to be slow, to 404, or to miss the cache.
 */

import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { MiniAppSdkFormat } from "../../resources/mini-app-sdk/sdk-manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * SDK sources must live OUTSIDE app.asar in packaged builds.
 *
 * esbuild is a native binary running as a separate process, and the asar
 * virtual filesystem is patched into Electron's `fs` only — a child process
 * sees `app.asar` as one opaque file. Do NOT probe with `existsSync` to
 * choose: Electron's patched `fs` reports the in-asar path as readable, which
 * is exactly the path esbuild cannot use.
 */
export function resolveMiniAppSdkDir(): string {
  const bundled = path.join(__dirname, "../../resources/mini-app-sdk");
  return bundled.includes(`app.asar${path.sep}`)
    ? bundled.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    : bundled;
}

export function prebuiltMiniAppSdkBundlePath(sdkFileName: string): string {
  return path.join(
    resolveMiniAppSdkDir(),
    "bundled",
    sdkFileName.replace(/\.ts$/, ".js"),
  );
}

/** Compiled once per process — the source cannot change without a restart. */
const compiled = new Map<string, string | null>();

/**
 * Drop an inline sourcemap before inlining into HTML.
 *
 * The prebuild emits `sourcemap: "inline"`, which is right for the
 * `/__papr__/` route — that response is cacheable and the map makes platform
 * scripts debuggable. It is wrong here: an inline map is tens of KB added to
 * *every* mini-app HTML response, on the critical path this change exists to
 * shorten, for scripts that are not the app's own code. The mapped build stays
 * available at its route, so nothing is lost.
 */
function stripInlineSourcemap(code: string): string {
  return code.replace(
    /\n?\/\/# sourceMappingURL=data:application\/json;[^\n]*/g,
    "",
  );
}

/**
 * Compiled JS for one SDK module, or null if it cannot be produced.
 *
 * Null rather than a throw: a preview that loads without the gate is degraded,
 * not broken, and the caller falls back to a `<script src>` tag. Failing the
 * whole HTML response would turn a slow bundle into a blank app.
 */
export async function loadMiniAppSdkSource(
  sdkFileName: string,
  format: MiniAppSdkFormat = "iife",
): Promise<string | null> {
  const memo = compiled.get(sdkFileName);
  if (memo !== undefined) {
    return memo;
  }

  let code: string | null = null;
  try {
    const prebuilt = prebuiltMiniAppSdkBundlePath(sdkFileName);
    if (existsSync(prebuilt)) {
      code = stripInlineSourcemap(readFileSync(prebuilt, "utf8"));
    } else {
      const esbuild = await import("esbuild");
      const result = await esbuild.build({
        entryPoints: [path.join(resolveMiniAppSdkDir(), sdkFileName)],
        bundle: true,
        format,
        platform: "browser",
        target: "es2020",
        write: false,
        // No sourcemap: an inline map is tens of KB on every HTML response,
        // and these are platform scripts rather than app code. The
        // /__papr__/ route still serves the mapped build for debugging.
        sourcemap: false,
      });
      code = result.outputFiles?.[0]?.text ?? null;
    }
  } catch (err) {
    console.warn(
      `[miniAppSdkSource] Could not compile ${sdkFileName} for inlining; falling back to a script tag:`,
      (err as Error).message,
    );
    code = null;
  }

  compiled.set(sdkFileName, code);
  return code;
}
