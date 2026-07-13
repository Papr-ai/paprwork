#!/usr/bin/env node
/**
 * Probe Claude.ai history API via Chrome CDP — captures headers + response bodies.
 */

import WebSocket from "ws";

const CDP_HOST = process.env.CHROME_CDP_URL ?? "http://127.0.0.1:9222";
const WAIT_MS = 6000;

/** @type {Array<Record<string, unknown>>} */
const records = [];

async function openTab(url) {
  const res = await fetch(`${CDP_HOST}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  return await res.json();
}

function interesting(url) {
  return url.includes("claude.ai/api/") && !url.includes("event_logging");
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 0;
    const pending = new Map();
    const send = (method, params = {}) => {
      const id = ++msgId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
    };
    ws.on("open", () => resolve({ ws, send }));
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
      if (msg.method === "Network.responseReceived") {
        const { response, requestId } = msg.params;
        if (!interesting(response.url)) return;
        const rec = {
          url: response.url,
          status: response.status,
          mimeType: response.mimeType,
          requestId,
        };
        records.push(rec);
        send("Network.getResponseBody", { requestId }).then((body) => {
          const text = body.base64Encoded
            ? Buffer.from(body.body, "base64").toString("utf8")
            : body.body;
          rec.bodyPreview = text.slice(0, 4000);
          rec.bodyLength = text.length;
        }).catch((e) => {
          rec.bodyError = String(e);
        });
      }
      if (msg.method === "Network.requestWillBeSent") {
        const { request } = msg.params;
        if (!interesting(request.url)) return;
        const rec = records.find((r) => r.url === request.url && !r.method);
        if (rec) {
          rec.method = request.method;
          rec.headers = request.headers;
        } else {
          records.push({
            url: request.url,
            method: request.method,
            headers: request.headers,
          });
        }
      }
    });
  });
}

async function main() {
  const tab = await openTab("https://claude.ai/chats");
  const { send, ws } = await connectCdp(tab.webSocketDebuggerUrl);
  await send("Network.enable", { maxTotalBufferSize: 50_000_000 });
  await send("Page.enable");

  await new Promise((r) => setTimeout(r, WAIT_MS));
  await send("Page.reload");
  await new Promise((r) => setTimeout(r, WAIT_MS));

  // Click first chat link via CDP
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        const a = document.querySelector('a[href*="/chat/"]');
        if (a) { a.click(); return a.href; }
        return null;
      })()
    `,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, WAIT_MS));

  await new Promise((r) => setTimeout(r, 2000));
  ws.close();

  console.log(JSON.stringify(records, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
