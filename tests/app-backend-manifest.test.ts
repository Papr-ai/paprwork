import { describe, expect, it } from "vitest";
import {
  backendHandlerRelativePath,
  backendManifestRelativePath,
  parseAppBackendManifest,
} from "../src/gateway/services/appRuntime/appBackendManifest.js";

describe("parseAppBackendManifest", () => {
  it("parses a valid v1 manifest", () => {
    const manifest = parseAppBackendManifest({
      version: 1,
      actions: {
        "fetch-attention-calls": {
          handler: "fetch_attention_calls.py",
          runtime: "python",
          keys: ["RR_ATTENTION_API_KEY"],
          timeoutMs: 120_000,
        },
      },
    });

    expect(manifest.version).toBe(1);
    expect(manifest.actions["fetch-attention-calls"]).toEqual({
      handler: "fetch_attention_calls.py",
      runtime: "python",
      keys: ["RR_ATTENTION_API_KEY"],
      timeoutMs: 120_000,
      description: undefined,
    });
  });

  it("parses node and typescript runtimes", () => {
    const nodeManifest = parseAppBackendManifest({
      version: 1,
      actions: {
        ping: { handler: "ping.mjs", runtime: "node" },
        fetch: { handler: "fetch.ts", runtime: "typescript" },
      },
    });
    expect(nodeManifest.actions.ping.runtime).toBe("node");
    expect(nodeManifest.actions.fetch.runtime).toBe("typescript");
  });

  it("parses sourceId on actions", () => {
    const manifest = parseAppBackendManifest({
      version: 1,
      actions: {
        save: {
          handler: "save.py",
          runtime: "python",
          sourceId: "billing",
        },
      },
    });
    expect(manifest.actions.save.sourceId).toBe("billing");
  });

  it("rejects handler extension mismatch", () => {
    expect(() =>
      parseAppBackendManifest({
        version: 1,
        actions: {
          bad: { handler: "handler.py", runtime: "node" },
        },
      }),
    ).toThrow(/must use extension/);
  });

  it("rejects path traversal in handler", () => {
    expect(() =>
      parseAppBackendManifest({
        version: 1,
        actions: {
          evil: { handler: "../secrets.py", runtime: "python" },
        },
      }),
    ).toThrow(/relative file name/);
  });

  it("rejects empty actions", () => {
    expect(() =>
      parseAppBackendManifest({
        version: 1,
        actions: {},
      }),
    ).toThrow(/non-empty/);
  });
});

describe("backend paths", () => {
  it("builds repo-relative paths", () => {
    expect(backendManifestRelativePath("app-123")).toBe(
      "apps/app-123/backend/manifest.json",
    );
    expect(backendHandlerRelativePath("app-123", "handler.py")).toBe(
      "apps/app-123/backend/handler.py",
    );
  });
});
