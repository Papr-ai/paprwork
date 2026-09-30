/**
 * Gateway readiness must be *answerable*, not only pushed.
 *
 * The supervisor pushes each status exactly once and latches it
 * (`startingNotified`, `gatewayReadyNotified`), and nothing replays it when the
 * renderer reloads. A renderer that attached its listener after the push sat at
 * "unknown" forever, and the WebSocket fallback only promotes
 * "starting"/"restarting" — so a live socket could not clear it either. Every
 * `getAutoContinueBlockReason` call then returned "gatewayNotReady".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const repoRoot = path.resolve(__dirname, "..");

function read(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

/** Strip line comments first, then block comments — see Issue 98's note. */
function stripComments(source: string): string {
  return source
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("supervisor records what it pushed", () => {
  const main = stripComments(read("src/electron/index.cjs"));

  it("records the status before sending, so a missed push is still recoverable", () => {
    const send = main.indexOf("_sendStatusToRenderer(status, message) {");
    expect(send).toBeGreaterThan(-1);
    const body = main.slice(send, send + 400);

    const recordAt = body.indexOf("this.lastStatus = { status, message }");
    const sendAt = body.indexOf('webContents.send("gateway:status"');
    expect(recordAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(-1);

    // Recorded first, and outside the window guard: the case this exists for is
    // precisely a renderer that was not there to receive the push.
    expect(recordAt).toBeLessThan(body.indexOf("mainWindow &&"));
    expect(recordAt).toBeLessThan(sendAt);
  });

  it("exposes the recorded status", () => {
    expect(main).toMatch(/getLastStatus\(\)\s*\{/);
  });

  it("answers a renderer query from the recorded status", () => {
    expect(main).toMatch(
      /ipcMain\.handle\(\s*"gateway:get-status"[\s\S]{0,120}getLastStatus\(\)/,
    );
  });
});

describe("renderer can ask", () => {
  it("preload exposes getStatus over the same channel", () => {
    const preload = stripComments(read("src/electron/preload.cjs"));
    expect(preload).toMatch(
      /getStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("gateway:get-status"\)/,
    );
  });

  const hook = stripComments(read("ui/hooks/useGatewaySupervisorStatus.ts"));

  it("queries on mount in addition to listening", () => {
    expect(hook).toMatch(/api\.getStatus\?\.\(\)/);
  });

  it("attaches the listener before querying, so no push can be missed", () => {
    expect(hook.indexOf("api.onStatusChange(")).toBeLessThan(
      hook.indexOf("api.getStatus?.()"),
    );
  });

  it("never lets a stale query answer overwrite a newer push", () => {
    const then = hook.indexOf("api.getStatus?.().then");
    expect(then).toBeGreaterThan(-1);
    // The guard must come before either setter in the callback.
    const callback = hook.slice(then, then + 300);
    const guardAt = callback.indexOf("if (pushed");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(callback.indexOf("setStatus("));
  });
});

describe("gatewayNotReady is not reported over a finished turn", () => {
  const recovery = stripComments(read("ui/lib/agentStreamRecovery.ts"));
  // Anchor past the parameter type's own closing brace — `\n}` matches
  // `}): AutoContinueBlockReason` first, which would slice the signature only
  // and leave every assertion below passing vacuously.
  const signatureEnd = recovery.indexOf(
    "): AutoContinueBlockReason | null {",
  );
  const body = recovery.slice(
    signatureEnd,
    recovery.indexOf("\n}", signatureEnd),
  );

  it("decides turnComplete before gatewayNotReady", () => {
    const complete = body.indexOf('return "turnComplete"');
    const notReady = body.indexOf('return "gatewayNotReady"');
    expect(complete).toBeGreaterThan(-1);
    expect(notReady).toBeGreaterThan(-1);
    expect(complete).toBeLessThan(notReady);
  });

  it("still reports isSending first — cheap and authoritative", () => {
    expect(body.indexOf('return "isSending"')).toBeLessThan(
      body.indexOf('return "gatewayNotReady"'),
    );
  });
});

describe("the block log does not fire per render", () => {
  const container = stripComments(
    read("ui/components/Chat/ChatContainer.tsx"),
  );

  it("logs only when the reason changes", () => {
    const log = container.indexOf("[AutoContinue] blocked for");
    expect(log).toBeGreaterThan(-1);
    const guard = container.lastIndexOf(
      "lastLoggedAutoContinueBlockRef.current !== autoContinueBlock",
      log,
    );
    expect(guard).toBeGreaterThan(-1);
  });

  it("clears the record once unblocked, so a later block logs again", () => {
    expect(container).toMatch(
      /lastLoggedAutoContinueBlockRef\.current = null/,
    );
  });
});
