/**
 * An empty chat pane has two causes and they need different words.
 *
 * `loadMessages` used to swallow its error and leave `messages` empty, which
 * is the same shape a brand-new chat has — so a conversation the gateway was
 * briefly unable to read was greeted with "What would you like to build?".
 * The user reads that as their thread being gone.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveEmptyChatPaneReason } from "../ui/utils/emptyChatPaneReason.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.join(ROOT, relativePath), "utf-8")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("resolveEmptyChatPaneReason", () => {
  it("greets a new chat when the load succeeded and found nothing", () => {
    expect(
      resolveEmptyChatPaneReason({
        historyLoadFailed: false,
        knownMessageCount: 0,
      }),
    ).toBe("new-chat");
  });

  it("greets a new chat when the load succeeded and metadata is unknown", () => {
    // Nothing failed, so there is nothing to report — empty means empty.
    expect(
      resolveEmptyChatPaneReason({ historyLoadFailed: false }),
    ).toBe("new-chat");
  });

  it("reports the failure when the load threw and metadata is unknown", () => {
    // The boot-window case the user hit. Chat metadata comes from `chat:list`
    // over the same gateway that just refused us, so "unknown" here is the
    // norm rather than an edge case — gating on it would make this inert
    // exactly when it is needed.
    expect(
      resolveEmptyChatPaneReason({ historyLoadFailed: true }),
    ).toBe("load-failed");
  });

  it("reports the failure when the chat is known to hold messages", () => {
    expect(
      resolveEmptyChatPaneReason({
        historyLoadFailed: true,
        knownMessageCount: 42,
      }),
    ).toBe("load-failed");
  });

  it("greets a new chat when the gateway already told us it is empty", () => {
    // Positive evidence of emptiness outranks the failed reload: we are not
    // guessing, so show the more useful screen.
    expect(
      resolveEmptyChatPaneReason({
        historyLoadFailed: true,
        knownMessageCount: 0,
      }),
    ).toBe("new-chat");
  });
});

describe("the failed load is actually recorded", () => {
  const source = readCode("ui/hooks/useChat.ts");

  it("sets historyLoadFailed in the catch, not only logs it", () => {
    // `finally` writes an entry back with isLoading:false either way, so
    // without this the failure leaves no trace at all and the pane cannot
    // tell the two empty states apart.
    const catchStart = source.indexOf('console.error("Failed to load messages:"');
    expect(catchStart).toBeGreaterThan(-1);
    const catchBlock = source.slice(catchStart, catchStart + 600);
    expect(catchBlock).toContain("historyLoadFailed: true");
  });

  it("clears the flag on a successful load", () => {
    // Otherwise the pane keeps apologising after the gateway comes back.
    expect(source).toContain("historyLoadFailed: false");
  });
});

describe("the pane chooses its words from that flag", () => {
  const source = readCode("ui/components/Chat/MessageList.tsx");

  it("routes the empty branch through the resolver", () => {
    expect(source).toContain("resolveEmptyChatPaneReason({");
    expect(source).toContain('emptyPaneReason === "load-failed"');
  });

  it("keeps the welcome screen as the other branch", () => {
    // The fix must not cost a new chat its starter prompts.
    expect(source).toContain("<WelcomeMessage />");
  });
});
