#!/usr/bin/env node
/** Quick capture of chat_conversation API responses */
import WebSocket from "ws";

const CDP = "http://127.0.0.1:9222";
const bodies = [];

const tab = await (await fetch(`${CDP}/json/new?https://claude.ai/chat/d2a08e0e-776a-4fd5-80ff-4221d7bd290f`, { method: "PUT" })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

const send = (method, params = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
};

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(msg.error);
    else res(msg.result);
  }
  if (msg.method === "Network.responseReceived") {
    const url = msg.params.response.url;
    if (!url.includes("chat_conversation") && !url.includes("bootstrap")) return;
    const requestId = msg.params.requestId;
    send("Network.getResponseBody", { requestId }).then((b) => {
      const text = b.base64Encoded
        ? Buffer.from(b.body, "base64").toString("utf8")
        : b.body;
      bodies.push({
        url,
        status: msg.params.response.status,
        len: text.length,
        body: text.slice(0, 6000),
      });
    }).catch(() => {});
  }
});

ws.on("open", async () => {
  await send("Network.enable", { maxTotalBufferSize: 50_000_000 });
  await new Promise((r) => setTimeout(r, 12000));
  ws.close();
});

ws.on("close", () => {
  console.log(JSON.stringify(bodies, null, 2));
});
