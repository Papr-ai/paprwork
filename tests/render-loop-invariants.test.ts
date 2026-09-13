/**
 * Regression guards for the "Maximum update depth exceeded" loop in the chat pane.
 *
 * The loop needed two ingredients, and each on its own was survivable:
 *
 *  1. `useModelPickerSettings` built `pickerModels` inline in its return, so
 *     the array had a new identity on every render. Every ChatContainer effect
 *     depending on it therefore re-ran on every render.
 *  2. That effect then called `setModelSettings` with a freshly-read object.
 *     Fresh reference means React never bails out, so the state "changed",
 *     which re-rendered, which re-ran the effect.
 *
 * Ingredient 1 alone was harmless for exactly as long as every effect
 * depending on it happened to bail out — far too sharp an edge to leave in
 * place, so both are guarded here.
 *
 * These are static invariant tests: the failure is a React render cycle, which
 * a unit test cannot reproduce without mounting the real tree, but the two
 * code-level properties that make it impossible are cheap to assert.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

describe("useModelPickerSettings — stable effect dependencies", () => {
  it("memoises pickerModels rather than rebuilding it every render", () => {
    const content = read("ui/hooks/useModelPickerSettings.ts");

    expect(content).toMatch(
      /useMemo\(\s*\(\)\s*=>\s*getPickerModels\(enabledIds\),\s*\[enabledIds\]\s*\)/,
    );
    // The inline form is what made the array unstable.
    expect(content).not.toMatch(/pickerModels:\s*getPickerModels\(/);
  });

  it("imports useMemo, so the guard above cannot be satisfied vacuously", () => {
    const content = read("ui/hooks/useModelPickerSettings.ts");
    expect(content).toMatch(/import \{[^}]*useMemo[^}]*\} from "react"/);
  });
});

describe("ChatContainer — model settings state cannot self-trigger", () => {
  it("sets model settings through a bail-out updater, not a bare fresh object", () => {
    const content = read("ui/components/Chat/ChatContainer.tsx");

    // A functional updater returning `prev` lets React skip the re-render when
    // nothing actually changed. The local's name is incidental, so it is
    // captured rather than spelled out — what matters is that the same value
    // is compared and then returned.
    expect(content).toMatch(
      /setModelSettings\(\s*\(prev\)\s*=>\s*\(?\s*sameSettings\(prev,\s*(\w+)\)\s*\?\s*prev\s*:\s*\1\s*\)?\s*,?\s*\)/,
    );
  });

  it("does not set model settings from a freshly-read object directly", () => {
    const content = read("ui/components/Chat/ChatContainer.tsx");

    // These are the shapes that never bail out, because every read builds a
    // new object.
    expect(content).not.toMatch(/setModelSettings\(\s*readChatSettings\(/);
    expect(content).not.toMatch(
      /setModelSettings\(\s*readNewChatDefaultSettings\(/,
    );
  });
});

describe("panes are wrapped in an error boundary", () => {
  it("contains a render throw to the tab it happened in", () => {
    const content = read("ui/components/Layout/ContentArea.tsx");

    // Without this, React's only recourse for a throw in one pane is to
    // unmount the whole tree — which reads as the entire app reloading and
    // takes every other tab with it.
    expect(content).toContain("PaneErrorBoundary");
    expect(content).toMatch(
      /<PaneErrorBoundary paneKey=\{tabId \?\? "unknown"\}>/,
    );
  });

  it("wraps every tab type, not just chat", () => {
    const content = read("ui/components/Layout/ContentArea.tsx");

    // The boundary sits around the result of the type switch rather than
    // around individual views, so a new tab type is covered by default.
    const renderView = content.slice(
      content.indexOf("const renderView = ("),
      content.indexOf("const renderViewForTab = ("),
    );
    expect(renderView).toContain("PaneErrorBoundary");
    expect(renderView).toContain("renderViewForTab(tabId, skipAgents)");
  });
});

describe("drafts are persisted outside React", () => {
  it("the store writes drafts through the durable copy", () => {
    const content = read("ui/stores/chatStore.ts");

    expect(content).toMatch(/writeDraft\(chatId, draft\)/);
    // Reads must fall back to storage, or a draft is lost whenever the
    // in-memory map is emptied (crash, reload, workspace switch).
    expect(content).toMatch(/return readDraft\(chatId\)/);
    expect(content).toMatch(/forgetDraft\(chatId\)/);
    // The temp -> permanent rename must carry the draft with it.
    expect(content).toMatch(/renameDraft\(oldChatId, newChatId\)/);
  });

  it("the draft store does not depend on React", () => {
    const content = read("ui/utils/chatDraftStore.ts");

    // It has to keep working while the tree above it has thrown.
    expect(content).not.toMatch(/from "react"/);
    expect(content).not.toMatch(/useChatStore/);
  });

  it("the composer seeds from the store getter, not the raw map", () => {
    const content = read("ui/components/Chat/InputBar.tsx");

    // Reading the map directly paints an empty composer over a draft that
    // still exists in storage.
    expect(content).toMatch(
      /useChatStore\.getState\(\)\.getDraftMessage\(chatId\)/,
    );
    expect(content).not.toMatch(/useState\(\s*draftMessage\s*\)/);
  });

  it("the composer flushes the debounce window on unmount and pagehide", () => {
    const content = read("ui/components/Chat/InputBar.tsx");

    // The 300ms debounce is exactly the window a crash lands in.
    expect(content).toMatch(/addEventListener\("pagehide", flush\)/);
    expect(content).toMatch(/removeEventListener\("pagehide", flush\)/);
  });
});
