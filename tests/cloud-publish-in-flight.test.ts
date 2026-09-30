import { describe, expect, it } from "vitest";
import {
  resetPublishInFlightForTests,
  withPublishInFlight,
} from "../src/gateway/services/cloudPublishInFlight.js";

describe("cloudPublishInFlight", () => {
  it("serializes concurrent publish operations per appId", async () => {
    resetPublishInFlightForTests();
    const order: string[] = [];

    const first = withPublishInFlight("app-1", async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first-end");
      return "first";
    });

    const second = withPublishInFlight("app-1", async () => {
      order.push("second-start");
      order.push("second-end");
      return "second";
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe("first");
    expect(secondResult).toBe("second");
    expect(order).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);
  });

  it("allows parallel publish operations for different appIds", async () => {
    resetPublishInFlightForTests();
    const order: string[] = [];

    await Promise.all([
      withPublishInFlight("app-a", async () => {
        order.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("a-end");
      }),
      withPublishInFlight("app-b", async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);

    expect(order.indexOf("b-end")).toBeLessThan(order.indexOf("a-end"));
  });
});
