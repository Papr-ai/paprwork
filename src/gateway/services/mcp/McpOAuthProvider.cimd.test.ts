import { describe, expect, it } from "vitest";
import { McpOAuthProvider } from "./McpOAuthProvider.js";
import { createMemoryMcpCredentialStore } from "./mcpCredentialStore.js";
import { builtinForHost } from "./mcpServerCatalog.js";
import { McpServerSignIn } from "./mcpServerSignIn.js";

const CIMD = "https://papr.ai/oauth/papr-work-client.json";
const base = { serverId: "x", store: createMemoryMcpCredentialStore(), interactive: false, openBrowser: () => {} };

describe("CIMD client metadata URL", () => {
  it("offers the metadata URL when no static client id", () => {
    expect(new McpOAuthProvider({ ...base, clientMetadataUrl: CIMD }).clientMetadataUrl).toBe(CIMD);
  });
  it("pre-registered client id wins over CIMD", () => {
    expect(new McpOAuthProvider({ ...base, clientMetadataUrl: CIMD, staticClientId: "abc" }).clientMetadataUrl).toBeUndefined();
  });
  it("unset by default (falls back to DCR)", () => {
    expect(new McpOAuthProvider(base).clientMetadataUrl).toBeUndefined();
  });
  it("heyBTW workspace URLs resolve to the heyBTW built-in", () => {
    expect(builtinForHost("https://mcp.heybtw.com/w/abc123/mcp")?.id).toBe("heybtw");
    expect(builtinForHost("https://example.com/mcp")).toBeUndefined();
  });
  it("server sign-in uses the CIMD URL as client_id when the AS supports it", async () => {
    const ss = new McpServerSignIn({ cloud: async () => new Response("{}"), clientMetadataUrl: CIMD });
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const id = await (ss as any).clientIdFor({ id: "heybtw", name: "heyBTW" }, { client_id_metadata_document_supported: true }, "https://as");
    expect(id).toBe(CIMD);
  });
});
