import { describe, expect, it } from "vitest";
import type { AppToolSpec } from "./appTools.js";
import type { ClaudeApp } from "./catalog.js";
import { findApp, toResultRows } from "./searchTool.js";

const app = { namespaceId: "ns1", slug: "scenario", title: "Scenario", cards: { views: {} } } as unknown as ClaudeApp;
const tools = [
  { name: "scenario_library", app, view: "library" },
  { name: "scenario_change", app, view: "change" },
] as unknown as AppToolSpec[];
const title = (a: ClaudeApp) => (a as unknown as { title: string }).title;

describe("papr_search helpers", () => {
  it("finds an app by name or slug", () => {
    expect(findApp([app], "Scenario", title)).toBe(app);
    expect(findApp([app], "scenario", title)).toBe(app);
    expect(findApp([app], "outreach", title)).toBeUndefined();
  });

  it("maps a hit to the card tool for its view, with args and a deep link", () => {
    const [row] = toResultRows(
      [{ namespaceId: "ns1", slug: "scenario", id: "v1", title: "This Was the Deck", snippet: "", view: "change", args: { video: "v1" }, url: "?video=v1" }],
      [app], tools, "https://apps.papr.ai", title,
    );
    expect(row).toMatchObject({ app: "Scenario", tool: "scenario_change", args: { video: "v1" }, openUrl: "https://apps.papr.ai/ns1/scenario/?video=v1" });
  });

  it("falls back to the app's first card when the hit names no view, and to no tool for an unknown view", () => {
    const hit = { namespaceId: "ns1", slug: "scenario", id: "v1", title: "T", snippet: "" };
    expect(toResultRows([hit], [app], tools, "https://apps.papr.ai", title)[0].tool).toBe("scenario_library");
    expect(toResultRows([{ ...hit, view: "gone" }], [app], tools, "https://apps.papr.ai", title)[0].tool).toBeUndefined();
  });
});
