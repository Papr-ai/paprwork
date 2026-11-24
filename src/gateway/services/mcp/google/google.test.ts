import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { b64urlDecode, b64urlEncode, buildRawEmail, messageText, replySubject } from "./gmailMime.js";
import { buildSearchQuery } from "./driveTools.js";
import { openNativeTransport } from "./nativeServer.js";
import { BUILTIN_MCP_SERVERS } from "../mcpServerCatalog.js";

describe("gmailMime", () => {
  it("round-trips base64url", () => {
    expect(b64urlDecode(b64urlEncode("héllo ✓ ?>"))).toBe("héllo ✓ ?>");
  });

  it("builds a reply with threading headers and encoded subject", () => {
    const raw = b64urlDecode(buildRawEmail({ to: ["a@x.com"], subject: "Café\r\nBcc: evil@x.com", body: "hi", inReplyTo: "<m1@x>" }));
    expect(raw).toContain("To: a@x.com\r\n");
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(raw).not.toMatch(/^Bcc: evil/m); // header injection stripped
    expect(raw).toContain("In-Reply-To: <m1@x>");
    expect(raw).toContain("References: <m1@x>");
    expect(raw.split("\r\n\r\n")[1].replace(/\r\n/g, "")).toBe(Buffer.from("hi").toString("base64"));
  });

  it("prefers text/plain, falls back to stripped html", () => {
    const enc = (s: string) => b64urlEncode(s);
    expect(messageText({ mimeType: "multipart/alternative", parts: [
      { mimeType: "text/html", body: { data: enc("<p>Hi</p>") } },
      { mimeType: "text/plain", body: { data: enc("Hi plain") } },
    ] })).toBe("Hi plain");
    expect(messageText({ mimeType: "text/html", body: { data: enc("<p>A &amp; B</p><br>C") } })).toBe("A & B\n\nC");
  });

  it("prefixes Re: once", () => {
    expect(replySubject("Plan")).toBe("Re: Plan");
    expect(replySubject("RE: Plan")).toBe("RE: Plan");
  });
});

describe("drive query", () => {
  it("escapes quotes and excludes trash by default", () => {
    expect(buildSearchQuery({ text: "Q3 'plan'", folderId: "f1" })).toBe("fullText contains 'Q3 \\'plan\\'' and 'f1' in parents and trashed = false");
    expect(buildSearchQuery({ includeTrashed: true })).toBe("");
  });
});

describe("catalog", () => {
  it("Google connectors are native, pinned scopes, fixed endpoints", () => {
    const g = BUILTIN_MCP_SERVERS.filter((s) => s.id === "gmail" || s.id === "googledrive");
    expect(g.map((s) => s.native)).toEqual(["googledrive", "gmail"]);
    for (const s of g) {
      expect(s.serverOAuth).toBe(true);
      expect(s.oauthEndpoints?.tokenEndpoint).toBe("https://oauth2.googleapis.com/token");
      expect(s.scopes?.length).toBe(1);
    }
  });
});

describe("native server over in-memory MCP", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists tools and retries once with a fresh token on 401", async () => {
    const calls: Array<{ url: string; auth: string | null; method?: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("Authorization");
      calls.push({ url, auth, method: init.method, body: init.body as string | undefined });
      if (auth === "Bearer stale") return new Response("{}", { status: 401 });
      if (url.includes("/messages/send")) return Response.json({ id: "m9", threadId: "t9" });
      return Response.json({ labels: [{ id: "L1", name: "Clients", type: "user" }] });
    }));
    let n = 0;
    const token = vi.fn(async (force?: boolean) => (force ? `fresh${++n}` : "stale"));
    const client = new Client({ name: "t", version: "1" });
    await client.connect(await openNativeTransport("gmail", token));

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["search_emails", "read_thread", "send_email", "create_draft", "modify_labels", "trash_emails"]));
    expect(tools.find((t) => t.name === "search_emails")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "trash_emails")?.annotations?.destructiveHint).toBe(true);

    const labels = await client.callTool({ name: "list_labels", arguments: {} });
    expect(JSON.stringify(labels.content)).toContain("Clients");
    expect(calls.map((c) => c.auth)).toEqual(["Bearer stale", "Bearer fresh1"]);

    const sent = await client.callTool({ name: "send_email", arguments: { to: ["b@x.com"], subject: "Hi", body: "Yo" } });
    expect(sent.isError).toBeFalsy();
    const raw = JSON.parse(calls.filter((c) => c.url.endsWith("/messages/send")).pop()!.body!).raw;
    expect(b64urlDecode(raw)).toContain("To: b@x.com");
    await client.close();
  });

  it("drive tools surface Google errors as tool errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "File not found: x" } }, { status: 404 })));
    const client = new Client({ name: "t", version: "1" });
    await client.connect(await openNativeTransport("googledrive", async () => "tok"));
    const r = await client.callTool({ name: "get_file", arguments: { fileId: "x" } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("File not found");
    await client.close();
  });
});
