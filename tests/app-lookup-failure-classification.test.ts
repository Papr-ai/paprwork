/**
 * A failure to reach the gateway is not a fact about the workspace.
 *
 * `MiniAppView` used to wrap its `app:get` call in a bare `catch` and report
 * every outcome as "This app is not in the current workspace" — which also
 * latches `appMissingInWorkspace` and blanks the pane for the life of the tab.
 * So a gateway that was merely still booting produced a permanent-looking
 * message telling the user to go and find a different workspace.
 *
 * These pin the classification, and the structural guards that stop the
 * underlying empty-list answer being produced in the first place.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  APP_LOOKUP_MAX_ATTEMPTS,
  APP_LOOKUP_RETRY_MS,
  classifyAppGetFailure,
} from "../ui/utils/appGetErrorMessage.js";
// Imported rather than retyped: if the gateway's wording changes, this test
// changes with it, so the classifier and the message it classifies cannot
// drift apart silently.
import { PaprIdentityUnresolvedError } from "../src/gateway/services/appOwnership.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Read source with comments removed, so an anchor that survives only inside a
 * comment cannot make an invariant pass.
 *
 * Line comments are stripped first on purpose: a line comment containing `/*`
 * — `// Unknown /api/* routes` appears in this repo — would otherwise open a
 * block-comment match that swallows everything up to the next `*​/`, quietly
 * deleting real code from the text being asserted against.
 */
function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.join(ROOT, relativePath), "utf-8")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function requireIndex(content: string, anchor: string, label: string): number {
  const index = content.indexOf(anchor);
  if (index === -1) {
    throw new Error(
      `${label} not found: ${JSON.stringify(anchor)} — the code was renamed ` +
        `or rewrapped. Update the anchor, never delete the invariant.`,
    );
  }
  return index;
}

function sliceBetween(
  source: string,
  startAnchor: string,
  endAnchor: string,
  label: string,
): string {
  const start = requireIndex(source, startAnchor, `${label} (start)`);
  const end = source.indexOf(endAnchor, start);
  if (end === -1) {
    throw new Error(
      `${label}: end anchor ${JSON.stringify(endAnchor)} not found after the ` +
        `start anchor — the slice would run to end of file and every ` +
        `assertion below would pass against unrelated code.`,
    );
  }
  return source.slice(start, end);
}

/**
 * `not_found` is the only classification that licenses a claim about *where*
 * an app lives. Everything else — `gateway_busy`, `unknown` — must leave that
 * claim unmade, so this is the predicate the component's latch hangs on.
 */
function saysAppIsNotHere(reason: string | undefined): boolean {
  return classifyAppGetFailure(reason) === "not_found";
}

describe("classifyAppGetFailure", () => {
  it("accepts the gateway's own not-found reply", () => {
    // The one case where the gateway looked, and answered about this app.
    expect(saysAppIsNotHere("App not found")).toBe(true);
    expect(saysAppIsNotHere("Error: App not found")).toBe(true);
  });

  it("rejects an absent reason, the least informative outcome there is", () => {
    expect(saysAppIsNotHere(undefined)).toBe(false);
    expect(saysAppIsNotHere("")).toBe(false);
  });

  it("classifies the boot-window transport errors as busy, not unknown", () => {
    // `unknown` gets no retry and generic copy, so leaving the two most
    // common boot strings out of the busy pattern means the usual case is
    // reported as unexplained rather than as "still starting".
    expect(classifyAppGetFailure("Gateway not connected")).toBe("gateway_busy");
    expect(classifyAppGetFailure("Gateway disconnected")).toBe("gateway_busy");
    expect(
      classifyAppGetFailure(new PaprIdentityUnresolvedError().message),
    ).toBe("gateway_busy");
  });

  it("does not read a bare namespace mention as a scoping verdict", () => {
    // The identity error says "the workspace is still starting" and mentions
    // the namespace; matching on that token alone turned a two-second
    // condition into a permanent-looking instruction to switch workspace.
    expect(
      saysAppIsNotHere("workspace is still starting for this namespace"),
    ).toBe(false);
  });

  // Verbatim from ui/src/lib/gateway.ts, which rejects `send` with
  // `new Error(response.error || ...)` — so these are the exact strings the
  // component's catch receives, not paraphrases of them.
  it.each([
    ["a socket that is not open", "Gateway not connected"],
    ["a request that timed out", "Request timeout"],
    ["a dropped stream", "Gateway disconnected"],
    ["a refused connection", "connect ECONNREFUSED 127.0.0.1:18789"],
    [
      "an unresolved identity",
      new PaprIdentityUnresolvedError().message,
    ],
  ])("rejects %s, which says nothing about where the app lives", (_label, reason) => {
    expect(saysAppIsNotHere(reason)).toBe(false);
  });

  it("prefers the transport reading when both phrases appear", () => {
    // Asymmetric costs: reading a transient failure as "not here" blanks a
    // working app and tells the user something false about their workspace,
    // while the reverse costs a few retries and then an honest message.
    expect(saysAppIsNotHere("timeout waiting for App not found")).toBe(false);
  });

  it("gives the gateway most of the window the supervisor itself waits", () => {
    // The main process waits up to 60s for the gateway to report ready before
    // loading the UI anyway, so a pane that gave up in a couple of seconds
    // would be giving up while the thing it needs is still on its way.
    const budgetMs = APP_LOOKUP_MAX_ATTEMPTS * APP_LOOKUP_RETRY_MS;
    expect(budgetMs).toBeGreaterThanOrEqual(25_000);
    expect(budgetMs).toBeLessThanOrEqual(60_000);
  });
});

describe("the renderer no longer states a scoping conclusion it cannot support", () => {
  const source = readCode("ui/components/Apps/MiniAppView.tsx");
  const effect = sliceBetween(
    source,
    "const probe = async (attempt: number)",
    "void probe(1);",
    "app:get probe",
  );

  it("latches appMissingInWorkspace only behind the classifier", () => {
    const guard = requireIndex(
      effect,
      'if (kind === "not_found") {',
      "classifier guard",
    );
    const latch = requireIndex(
      effect,
      "setAppMissingInWorkspace(true)",
      "appMissingInWorkspace latch",
    );

    // Inside the guarded branch, not before it. `appMissingInWorkspace`
    // suppresses the iframe outright, so setting it on a transient failure
    // blanks the pane until the tab is recreated.
    expect(latch).toBeGreaterThan(guard);

    // And exactly once — a second unguarded call would restore the bug.
    expect(effect.split("setAppMissingInWorkspace(true)").length - 1).toBe(1);
  });

  it("retries rather than concluding, while attempts remain", () => {
    expect(effect).toContain("attempt < APP_LOOKUP_MAX_ATTEMPTS");
    expect(effect).toContain("void probe(attempt + 1)");
  });

  it("cancels in-flight work so a closed tab cannot write to a dead component", () => {
    expect(source).toContain("cancelled = true;");
    expect(effect).toContain("if (cancelled) return;");
  });
});

describe("the gateway no longer answers with a list it cannot stand behind", () => {
  const source = readCode("src/gateway/services/AppService.ts");

  it("guards listApps before the ownership filter, not after", () => {
    const body = sliceBetween(
      source,
      "async listApps(): Promise<MiniApp[]> {",
      "async listUnassignedApps(",
      "listApps",
    );

    const guard = requireIndex(
      body,
      "assertPaprIdentityResolved();",
      "identity guard in listApps",
    );
    const filter = requireIndex(
      body,
      "isAppOwnedByCurrentUser(app, hints)",
      "ownership filter in listApps",
    );

    // After the filter the list is already empty and the damage is done.
    expect(guard).toBeLessThan(filter);
  });

  it("guards getApp between the existence check and the ownership filter", () => {
    const body = sliceBetween(
      source,
      "async getApp(id: string): Promise<MiniApp | null> {",
      "\n  async ",
      "getApp",
    );

    const exists = requireIndex(body, "this.apps.get(id)", "existence lookup");
    const guard = requireIndex(
      body,
      "assertPaprIdentityResolved();",
      "identity guard in getApp",
    );
    const filter = requireIndex(
      body,
      "isAppOwnedByCurrentUser(app, hints)",
      "ownership filter in getApp",
    );

    // A genuinely missing app must still answer null rather than erroring
    // about identity, so the guard sits after the existence check...
    expect(guard).toBeGreaterThan(exists);
    // ...and before the filter whose null the user reads as a scoping claim.
    expect(guard).toBeLessThan(filter);
  });

  it("awaits initialization in getApp, as every other read path does", () => {
    const body = sliceBetween(
      source,
      "async getApp(id: string): Promise<MiniApp | null> {",
      "\n  async ",
      "getApp",
    );

    const init = requireIndex(body, "await this.initialize();", "initialize");
    const lookup = requireIndex(body, "this.apps.get(id)", "map lookup");

    // Without this the map is empty until initialize() happens to have run,
    // so a present app reports "App not found" during boot — which the
    // classifier above would (correctly, given the message) treat as final.
    expect(init).toBeLessThan(lookup);
  });
});

describe("a failed refresh does not overwrite a good cache", () => {
  const source = readCode("ui/hooks/useArtifacts.ts");

  it("keeps the existing apps when app:list rejected", () => {
    expect(source).toContain(
      'const keepExistingApps = appsResult.status === "rejected";',
    );
    expect(source).toContain("if (!keepExistingApps) {");
  });

  it("writes the workspace cache only on a result it believes", () => {
    const loader = sliceBetween(
      source,
      "const loadArtifacts = useCallback",
      "}, [scope, setArtifacts",
      "loadArtifacts",
    );

    // Two sites, each reachable only on success, by different means. The
    // `scope === "apps"` branch awaits `app:list` directly, so a rejection
    // throws past its persist; the `all` branch uses `allSettled` and so
    // needs the explicit guard. Pinning the count catches a third site being
    // added without either protection — the cache is what the next launch
    // hydrates from, so writing a failure's shape into it turns a transient
    // outage into a state that survives a restart.
    const persists = loader.split("persistArtifactsToWorkspaceCache(").length - 1;
    expect(persists).toBe(2);
    expect(loader).toContain(
      "if (!keepExistingApps) {\n          persistArtifactsToWorkspaceCache(nextApps);",
    );
  });
});
