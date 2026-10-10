/** Test helper: connects a card-side BridgePort to the reference MCP Apps host (ext-apps AppBridge). */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { BridgePort } from "../../src/resources/mini-app-sdk/papr-mcp-bridge.ts";

export async function connectToReferenceHost(setup?: (host: AppBridge) => void): Promise<{ host: AppBridge; port: BridgePort }> {
  const [cardSide, hostSide] = InMemoryTransport.createLinkedPair();
  const host = new AppBridge(
    null,
    { name: "test-host", version: "1.0.0" },
    { openLinks: {}, serverTools: {}, updateModelContext: { text: {} } },
    { hostContext: { theme: "dark", styles: { variables: { "--color-text-primary": "#fff" } } } as never },
  );
  setup?.(host);
  await host.connect(hostSide);
  const port: BridgePort = {
    post: (m) => void cardSide.send(m as never),
    listen: (h) => {
      cardSide.onmessage = (m) => h(m as never);
      void cardSide.start();
      return () => (cardSide.onmessage = undefined);
    },
  };
  return { host, port };
}
