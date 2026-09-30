import type { PaprQuotaStatus } from "../../core/utils/paprQuota.js";
import { broadcast } from "../websocket/index.js";

export interface PaprQuotaBroadcastPayload extends PaprQuotaStatus {
  reportedAt: string;
}

export function broadcastPaprQuotaStatus(status: PaprQuotaStatus): void {
  const payload: PaprQuotaBroadcastPayload = {
    ...status,
    reportedAt: new Date().toISOString(),
  };
  broadcast({ type: "papr:quota-status", data: payload });
}
