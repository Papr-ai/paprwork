#!/usr/bin/env node
/** Attach to existing signed-in Claude tab and capture history API calls. */

import WebSocket from "ws";

const CDP = process.env.CHROME_CDP_URL ?? "http://127.0.0.1:9222";
const TARGET_TAB_URL = process.env.CLAUDE_TAB_URL ?? "https://claude.ai/new";

/** @type {Array<{ status?: number; method?: string; url: string; body?: string; len?: number }>} */
const records = [];

async function findTab() {
  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  const tab = tabs.find((t) => t.url === TARGET_TAB_URL || t.url?.includes("claude.ai/chat"));
  if (!tab) {
    console.error("No signed-in Claude tab found. Open https://claude.ai in Chrome.");
    process.exit(1);
  }
  return tab;
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
      if (msg.method === "Network.requestWillBeSent") {
        const { request } = msg.params;
        const url = request.url;
        if (
          url.includes("claude.ai") &&
          (url.includes("/api/") || url.includes("edge-api")) &&
          !url.includes("event_logging")
        ) {
          const rec = records.find((r) => r.url === url && !r.method);
          if (rec) rec.method = request.method;
          else records.push({ url, method: request.method });
        }
      }
      if (msg.method === "Network.responseReceived") {
        const { response, requestId } = msg.params;
        const url = response.url;
        if (
          !url.includes("claude.ai") ||
          !url.includes("/api/") ||
          url.includes("event_logging")
        ) {
          return;
        }
        const rec = records.find((r) => r.url === url);
        if (rec) rec.status = response.status;
        const shouldBody =
          url.includes("chat_conversation") ||
          url.includes("bootstrap") ||
          url.includes("current_user");
        if (shouldBody) {
          send("Network.getResponseBody", { requestId }).then((body) => {
            const text = body.base64Encoded
              ? Buffer.from(body.body, "base64").toString("utf8")
              : body.body;
            if (rec) {
              rec.len = text.length;
              rec.body = text.slice(0, 5000);
            }
          }).catch(() => {});
        }
      }
    });
  });
}

async function main() {
  const tab = await findTab();
  console.log(`Attached to: ${tab.url}`);
  const { ws, send } = await connectCdp(tab.webSocketDebuggerUrl);
  await send("Network.enable", { maxTotalBufferSize: 50_000_000 });
  await send("Page.enable");

  console.log("Navigating to /chats...");
  await send("Page.navigate", { url: "https://claude.ai/chats" });
  await new Promise((r) => setTimeout(r, 8000));

  console.log("Clicking first existing chat...");
  const click = await send("Runtime.evaluate", {
    expression: `(() => {
      const links = [...document.querySelectorAll('a[href*="/chat/"]')]
        .filter(a => !a.href.includes('/new'));
      if (links[0]) { links[0].click(); return links[0].href; }
      return null;
    })()`,
    returnByValue: true,
  });
  console.log("Clicked:", click.result?.value);
  await new Promise((r) => setTimeout(r, 8000));

  ws.close();

  const conv = records.filter((r) =>
    r.url.includes("chat_conversation") ||
    r.url.includes("bootstrap") ||
    r.url.includes("current_user_access"),
  );

  console.log("\n=== Conversation-related calls ===");
  for (const r of conv) {
    console.log(`${r.status ?? "?"} ${r.method ?? "?"} ${r.url}`);
    if (r.body) {
      console.log(`  len=${r.len} preview=${r.body.slice(0, 600)}...\n`);
    }
  }

  console.log("\n=== All unique API paths (no query) ===");
  const paths = [...new Set(records.map((r) => {
    try {
      const u = new URL(r.url);
      return `${r.status ?? "?"} ${r.method ?? "?"} ${u.pathname}`;
    } catch {
      return r.url;
    }
  }))].sort();
  paths.forEach((p) => console.log(p));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
