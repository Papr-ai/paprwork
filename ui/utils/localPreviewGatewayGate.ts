export interface LocalPreviewGatewayGateInput {
  isPublishedPreview: boolean;
  iframeActivated: boolean;
  gatewaySupervisorReady: boolean;
  gatewaySupervisorStarting: boolean;
  gatewayConnected: boolean;
}

/**
 * Local mini-app iframe loads only after the gateway can serve /apps/* routes.
 * Prefer supervisor "ready"; fall back to a live WebSocket when IPC was missed.
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
