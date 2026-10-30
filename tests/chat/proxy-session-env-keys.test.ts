import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// A Papr-proxy session must not write the Papr key into a provider's key slot
// (OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_*): later sessions read those
// slots as real provider keys.
describe("ChatSessionManager.createAgent — Papr proxy", () => {
  it("skips the provider env-key writes when the session uses the Papr proxy", () => {
    const src = readFileSync(
      path.join(__dirname, "../../src/gateway/services/ChatSessionManager.ts"),
      "utf8",
    );
    const start = src.indexOf("private async createAgent(");
    const writes = src.indexOf("process.env.ANTHROPIC_API_KEY = config.apiKey", start);
    const guard = src.indexOf("if (config.usePaprProxy) {", start);
    expect(start).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(start);
    expect(guard).toBeLessThan(writes);
  });
});
