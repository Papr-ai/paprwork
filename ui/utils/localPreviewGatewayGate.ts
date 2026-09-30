export interface LocalPreviewGatewayGateInput {
  isPublishedPreview: boolean;
  iframeActivated: boolean;
  gatewaySupervisorReady: boolean;
  gatewaySupervisorStarting: boolean;
  gatewayConnected: boolean;
}

/**
 * When to point the local mini-app iframe at the gateway.
 *
 * This is a best-effort gate, not a guarantee, and the difference matters: the
 * WebSocket fallback below is not evidence that `/apps/*` is routable. The
 * gateway attaches its WebSocket server before it binds the port and registers
 * those routes long afterwards, so a handshake succeeds during the whole boot
 * window — which is how an iframe came to render `Cannot GET /apps/<id>/...`.
 *
 * The fallback stays because the supervisor pushes "starting" exactly once, so a
 * renderer that loads later never hears it and would otherwise wait forever.
 * What makes loading early safe is the gateway answering 503 with a page that
 * waits and reloads itself (`gatewayBootGate.ts`), rather than a 404 that reads
 * as "this app is gone".
 */
export function canLoadLocalAppPreview(input: LocalPreviewGatewayGateInput): boolean {
  if (input.isPublishedPreview || !input.iframeActivated) {
    return false;
  }
  if (input.gatewaySupervisorReady) {
    return true;
  }
  return !input.gatewaySupervisorStarting && input.gatewayConnected;
}

export function isWaitingForLocalPreviewGateway(
  input: LocalPreviewGatewayGateInput,
): boolean {
  return input.iframeActivated && !input.isPublishedPreview && !canLoadLocalAppPreview(input);
}
