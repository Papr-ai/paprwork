import { describe, expect, it } from "vitest";

import {
  teamCatalogQuery,
  teamEntryFromApi,
} from "../src/gateway/services/CommunityCatalogService.js";

describe("teamCatalogQuery", () => {
  it("appends namespaceId query param for memory server team routes", () => {
    expect(teamCatalogQuery("onnNQFe3DN")).toBe("?namespaceId=onnNQFe3DN");
    expect(teamCatalogQuery("aXNvpekYXn")).toBe("?namespaceId=aXNvpekYXn");
  });

  it("encodes special characters in namespace ids", () => {
    expect(teamCatalogQuery("ns/with space")).toBe(
      "?namespaceId=ns%2Fwith%20space",
    );
  });
});

describe("teamEntryFromApi", () => {
  it("defaults missing namespaceId and visibility from route scope", () => {
    const entry = teamEntryFromApi(
      {
        appId: "abc123",
        name: "Team Dash",
      },
      "onnNQFe3DN",
    );
    expect(entry.namespaceId).toBe("onnNQFe3DN");
    expect(entry.visibility).toBe("team");
  });

  it("preserves explicit namespaceId and visibility from API", () => {
    const entry = teamEntryFromApi(
      {
        appId: "abc123",
        name: "Team Dash",
        namespaceId: "other-ns",
        visibility: "team_read",
      },
      "onnNQFe3DN",
    );
    expect(entry.namespaceId).toBe("other-ns");
    expect(entry.visibility).toBe("team_read");
  });
});
