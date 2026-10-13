import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { downgradeNewerProtocolVersion } from "./protocolVersion.js";

type Rpc = { result: { protocolVersion?: string; tools?: Array<{ name: string }>; content?: Array<{ text: string }> } };
const rpc = async (r: Response): Promise<Rpc> => (await r.json()) as Rpc;

const req = (v?: string) => ({
  headers: v === undefined ? {} : { "mcp-protocol-version": v },
  rawHeaders: v === undefined ? [] : ["MCP-Protocol-Version", v],
});

describe("downgradeNewerProtocolVersion", () => {
  it("maps a newer dated version to our latest, in headers and rawHeaders", () => {
    const r = req("2026-07-28");
    expect(downgradeNewerProtocolVersion(r)).toBe("2026-07-28");
    expect(r.headers["mcp-protocol-version"]).toBe(LATEST_PROTOCOL_VERSION);
    expect(r.rawHeaders[1]).toBe(LATEST_PROTOCOL_VERSION);
  });
  it("leaves supported, missing, older-unknown and malformed versions alone", () => {
    for (const v of [LATEST_PROTOCOL_VERSION, "2025-06-18", undefined, "2023-01-01", "banana", "9999"]) {
      const r = req(v);
      expect(downgradeNewerProtocolVersion(r)).toBeNull();
      expect(r.headers).toEqual(req(v).headers);
    }
  });
});

describe("a stateless MCP endpoint behind the downgrade", () => {
  let server: Server;
  let url = "";
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.post("/mcp", async (rq, rs) => {
      downgradeNewerProtocolVersion(rq);
      const mcp = new McpServer({ name: "t", version: "1" });
      mcp.tool("ping", async () => ({ content: [{ type: "text", text: "pong" }] }));
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      rs.on("close", () => { void t.close(); void mcp.close(); });
      await mcp.connect(t);
      await t.handleRequest(rq, rs, rq.body);
    });
    server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  const post = (version: string, body: unknown) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": version },
    body: JSON.stringify(body),
  });

  it("answers initialize from a newer client with our latest version", async () => {
    const r = await post("2026-07-28", { jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "claude", version: "x" } } });
    expect(r.status).toBe(200);
    expect((await rpc(r)).result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });
  it("serves tools/list and tools/call sent with a newer version header (was 400)", async () => {
    const list = await post("2026-07-28", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    expect((await rpc(list)).result.tools?.map((t) => t.name)).toContain("ping");
    const call = await post("2026-07-28", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: {} } });
    expect(call.status).toBe(200);
    expect((await rpc(call)).result.content?.[0]?.text).toBe("pong");
  });
  it("still rejects a malformed version", async () => {
    const r = await post("banana", { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    expect(r.status).toBe(400);
  });
});
