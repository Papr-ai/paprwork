import { describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { legacyBodyWithModernHeader } from "./protocolVersion.js";

const req = (v?: string) => ({
  headers: v === undefined ? {} : { "mcp-protocol-version": v },
  rawHeaders: v === undefined ? [] : ["MCP-Protocol-Version", v],
});
const legacyBody = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const modernBody = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } };

describe("legacyBodyWithModernHeader", () => {
  it("serves a 2025-style body sent with a newer header as our latest 2025 revision", () => {
    const r = req("2026-07-28");
    expect(legacyBodyWithModernHeader(r, legacyBody)).toBe("2026-07-28");
    expect(r.headers["mcp-protocol-version"]).toBe(LATEST_PROTOCOL_VERSION);
    expect(r.rawHeaders[1]).toBe(LATEST_PROTOCOL_VERSION);
  });
  it("leaves real 2026-07-28 traffic (with the envelope) alone", () => {
    const r = req("2026-07-28");
    expect(legacyBodyWithModernHeader(r, modernBody)).toBeNull();
    expect(r.headers["mcp-protocol-version"]).toBe("2026-07-28");
  });
  it("leaves supported, missing, older-unknown and malformed headers alone", () => {
    for (const v of [LATEST_PROTOCOL_VERSION, "2025-06-18", undefined, "2023-01-01", "banana", "9999"]) {
      const r = req(v);
      expect(legacyBodyWithModernHeader(r, legacyBody)).toBeNull();
      expect(r.headers).toEqual(req(v).headers);
    }
  });
});
