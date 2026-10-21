import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  isCredentialGateExemptPath,
  isDocumentRequest,
  withSkipParam,
} from "./CloudAppHostCredentialService.js";

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

describe("Look around first", () => {
  const req = (dest?: string) => ({ headers: dest ? { "sec-fetch-dest": dest } : {} }) as unknown as Request;

  it("only sends page loads to setup, never the app's scripts or styles", () => {
    expect(isDocumentRequest(req("document"), "index.html")).toBe(true);
    expect(isDocumentRequest(req("iframe"), "")).toBe(true);
    expect(isDocumentRequest(req("script"), "dist/app.js")).toBe(false);
    expect(isDocumentRequest(req(), "dist/app.js")).toBe(false);
    expect(isDocumentRequest(req(), "style.css")).toBe(false);
    expect(isDocumentRequest(req(), "insights")).toBe(true);
  });

  it("carries the skip in the URL for iframes that drop the cookie", () => {
    expect(withSkipParam("/ns/app/")).toBe("/ns/app/?papr_skip=1");
    expect(withSkipParam("/ns/app/?tab=a")).toBe("/ns/app/?tab=a&papr_skip=1");
  });
});
