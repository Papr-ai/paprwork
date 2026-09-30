import { describe, expect, it } from "vitest";
import {
  classifyFdPressure,
  getOpenFdCount,
} from "../src/gateway/services/FdWatchdog.js";

describe("FdWatchdog", () => {
  it("reads open fd count on unix", () => {
    if (process.platform === "win32") {
      expect(getOpenFdCount()).toBeNull();
      return;
    }
    const count = getOpenFdCount();
    expect(count).not.toBeNull();
    expect(count!).toBeGreaterThan(2);
  });

  it("classifies fd pressure levels", () => {
    expect(classifyFdPressure(100, 5000, 8000)).toBe("ok");
    expect(classifyFdPressure(5000, 5000, 8000)).toBe("warn");
    expect(classifyFdPressure(8000, 5000, 8000)).toBe("critical");
    expect(classifyFdPressure(null, 5000, 8000)).toBe("unknown");
  });
});
