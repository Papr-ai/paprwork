import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Guards the contributor → main leak: the gateway must never infer "main".
describe("appCodePush gate", () => {
  const gw = readFileSync(path.resolve(__dirname, "../../cloud-agent-gateway.ts"), "utf8");
  const ctx = readFileSync(path.resolve(__dirname, "cloudAgentRunContext.ts"), "utf8");

  it("both request parsers forward appCodePush and callerRole", () => {
    expect(gw.match(/appCodePush: parseAppCodePush\(body\.appCodePush\)/g)?.length).toBe(2);
    expect(gw.match(/callerRole: typeof body\.callerRole/g)?.length).toBe(2);
  });

  it("missing / unknown appCodePush means no push", () => {
    expect(gw).toMatch(/value === "main" \|\| value === "proposal" \? value : "none"/);
    expect(ctx).toMatch(/const canPushAppCode = request\.appCodePush === "main";/);
    expect(ctx).not.toMatch(/appCodePush \?\? "main"/);
  });
});

// Catalog apps loaded mid-run aren't watched; the write itself must queue the push.
describe("cloud app edits reach the writer", () => {
  it("writeAppFile notifies the cloud writer in cloud runs", () => {
    const svc = readFileSync(path.resolve(__dirname, "../AppService.ts"), "utf8");
    const write = svc.slice(svc.indexOf("  async writeAppFile("), svc.indexOf("  async buildApp("));
    expect(write).toMatch(/GATEWAY_MODE === "cloud_agent"[\s\S]*notifyCloudSandboxAppSave\(appId\)/);
  });
});
