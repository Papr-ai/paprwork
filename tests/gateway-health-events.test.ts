import { expect, test } from "vitest";
import { recordGatewayHealthEvent, getGatewayHealthEvents } from "../src/gateway/services/gatewayHealthEvents.js";
test("health markers validate, deduplicate and retain the original observation time", () => {
 const event = { id: "health-1", timestamp: "2026-09-17T20:00:00.000Z", status: "failed", reason: "timeout", gatewayPid: process.pid };
 recordGatewayHealthEvent(event); recordGatewayHealthEvent(event);
 recordGatewayHealthEvent({ ...event, id: "wrong-process", gatewayPid: -1 });
 recordGatewayHealthEvent({ ...event, id: "invalid", timestamp: "invalid" });
 expect(getGatewayHealthEvents()).toEqual([event]);
 for(let i=0;i<300;i++)recordGatewayHealthEvent({ ...event, id: String(i) });
 expect(getGatewayHealthEvents()).toHaveLength(256);
});
