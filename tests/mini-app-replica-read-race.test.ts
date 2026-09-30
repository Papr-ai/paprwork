import { describe, expect, it } from "vitest";
import { raceFirstSuccessful } from "../src/gateway/services/appRuntime/DbRouter.js";

describe("raceFirstSuccessful", () => {
  it("returns the first path that succeeds", async () => {
    const { value, label } = await raceFirstSuccessful([
      {
        label: "slow",
        run: () =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve("slow"), 50);
          }),
      },
      {
        label: "fast",
        run: async () => "fast",
      },
    ]);
    expect(label).toBe("fast");
    expect(value).toBe("fast");
  });

  it("waits for a slower path when the fast path fails", async () => {
    const { value, label } = await raceFirstSuccessful([
      {
        label: "fail",
        run: async () => {
          throw new Error("local timeout");
        },
      },
      {
        label: "primary",
        run: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return "ok";
        },
      },
    ]);
    expect(label).toBe("primary");
    expect(value).toBe("ok");
  });

  it("rejects when every path fails", async () => {
    await expect(
      raceFirstSuccessful([
        { label: "a", run: async () => { throw new Error("a"); } },
        { label: "b", run: async () => { throw new Error("b"); } },
      ]),
    ).rejects.toThrow("a");
  });
});
