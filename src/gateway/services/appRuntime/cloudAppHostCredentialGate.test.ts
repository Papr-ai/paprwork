import { describe, expect, it } from "vitest";
import { isCredentialGateExemptPath } from "./CloudAppHostCredentialService.js";

describe("isCredentialGateExemptPath", () => {
  it("lets Claude card files through the credential setup redirect", () => {
    expect(isCredentialGateExemptPath("dist/cards/cards.json")).toBe(true);
    expect(isCredentialGateExemptPath("dist/cards/outreach.html")).toBe(true);
  });

  it("keeps the gate on the app itself", () => {
    expect(isCredentialGateExemptPath("index.html")).toBe(false);
    expect(isCredentialGateExemptPath("dist/app.js")).toBe(false);
    expect(isCredentialGateExemptPath("api/db/query")).toBe(false);
    expect(isCredentialGateExemptPath("cards/outreach.ts")).toBe(false);
  });

  it("rejects traversal out of dist/cards", () => {
    expect(isCredentialGateExemptPath("dist/cards/../app.js")).toBe(false);
  });
});
