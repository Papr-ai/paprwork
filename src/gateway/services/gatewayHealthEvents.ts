/** Supervisor observations use the original timestamp, even if IPC delivery is delayed. */
export interface GatewayHealthEvent {
  id: string; timestamp: string; status: "failed" | "recovered";
  reason: string; gatewayPid: number;
}
const events: GatewayHealthEvent[] = [];
export function recordGatewayHealthEvent(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const e = value as GatewayHealthEvent;
  if (typeof e.id !== "string" || e.id.length > 100 || !Number.isFinite(Date.parse(e.timestamp)) ||
      !["failed", "recovered"].includes(e.status) || typeof e.reason !== "string" ||
      e.gatewayPid !== process.pid || events.some(event => event.id === e.id)) return;
  events.push({ id: e.id, timestamp: e.timestamp, status: e.status, reason: e.reason.slice(0, 160), gatewayPid: e.gatewayPid });
  if (events.length > 256) events.shift();
}
export function getGatewayHealthEvents(): GatewayHealthEvent[] { return events.map(event => ({ ...event })); }
