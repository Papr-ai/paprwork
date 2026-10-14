import { describe, expect, it } from "vitest";
import { allowedIn, loadListingPolicy, personalConnectorNote, splitForConnector } from "./listing.js";
import type { ClaudeApp } from "./catalog.js";

const app = (slug: string) => ({ namespaceId: "ns", slug, title: slug, cards: { enabled: true, views: {} } }) as unknown as ClaudeApp;

describe("listing policy", () => {
  it("reads ns/slug keys from PAPR_MCP_LISTED_APPS and ignores junk", () => {
    const p = loadListingPolicy({ PAPR_MCP_LISTED_APPS: "ns/notes, ns/crm  bad key,../x" });
    expect([...p.reviewed]).toEqual(["ns/notes", "ns/crm"]);
  });
  it("personal shows everything; listed shows only reviewed apps", () => {
    const p = loadListingPolicy({ PAPR_MCP_LISTED_APPS: "ns/notes" });
    const apps = [app("notes"), app("linkedin-outreach"), app("scenario")];
    expect(splitForConnector("personal", p, apps).shown).toHaveLength(3);
    const listed = splitForConnector("listed", p, apps);
    expect(listed.shown.map((a) => a.slug)).toEqual(["notes"]);
    expect(listed.personalOnly.map((a) => a.slug)).toEqual(["linkedin-outreach", "scenario"]);
    expect(allowedIn("listed", p, { namespaceId: "ns", slug: "scenario" })).toBe(false);
    expect(allowedIn("personal", p, { namespaceId: "ns", slug: "scenario" })).toBe(true);
  });
  it("names the apps and the personal connector URL", () => {
    const t = personalConnectorNote("https://mcp.papr.ai/mcp", ["Scenario", "LinkedIn Outreach"]);
    expect(t).toContain("Scenario, LinkedIn Outreach work in Claude through your personal Papr connector");
    expect(t).toContain("https://mcp.papr.ai/mcp");
    expect(personalConnectorNote("u", [])).toBe("");
  });
});
