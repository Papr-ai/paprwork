import { describe, expect, it } from "vitest";
import {
  canLoadLocalAppPreview,
  isWaitingForLocalPreviewGateway,
} from "../ui/utils/localPreviewGatewayGate.js";

const base = {
  isPublishedPreview: false,
  iframeActivated: true,
  gatewaySupervisorReady: false,
  gatewaySupervisorStarting: false,
  gatewayConnected: false,
};

describe("localPreviewGatewayGate", () => {
  it("blocks until supervisor ready", () => {
    expect(canLoadLocalAppPreview({ ...base, gatewaySupervisorReady: true })).toBe(
      true,
    );
    expect(canLoadLocalAppPreview(base)).toBe(false);
  });

  it("allows load when WebSocket is up but supervisor IPC was missed", () => {
    expect(
      canLoadLocalAppPreview({
        ...base,
        gatewayConnected: true,
      }),
    ).toBe(true);
  });

  it("blocks while supervisor reports starting even if connected", () => {
    expect(
      canLoadLocalAppPreview({
        ...base,
        gatewaySupervisorStarting: true,
        gatewayConnected: true,
      }),
    ).toBe(false);
  });

  it("never loads published preview through the local gate", () => {
    expect(
      canLoadLocalAppPreview({
        ...base,
        isPublishedPreview: true,
        gatewaySupervisorReady: true,
      }),
    ).toBe(false);
  });

  it("waits only when activated tab needs gateway", () => {
    expect(isWaitingForLocalPreviewGateway(base)).toBe(true);
    expect(
      isWaitingForLocalPreviewGateway({
        ...base,
        gatewaySupervisorReady: true,
      }),
    ).toBe(false);
    expect(
      isWaitingForLocalPreviewGateway({
        ...base,
        iframeActivated: false,
      }),
    ).toBe(false);
  });
});
