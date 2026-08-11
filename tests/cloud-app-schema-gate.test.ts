import { describe, expect, it } from "vitest";
import { injectSchemaGateBanner } from "../src/gateway/services/appRuntime/cloudAppSchemaGate.js";

describe("injectSchemaGateBanner", () => {
  it("injects banner after body open tag", () => {
    const html = "<html><body><p>App</p></body></html>";
    const banner = "<div>syncing</div>";
    const result = injectSchemaGateBanner(html, banner);
    expect(result).toContain("<body><div>syncing</div>");
    expect(result).toContain("<p>App</p>");
  });
});
