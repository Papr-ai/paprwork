import { expect, test, vi } from "vitest";
vi.mock("../src/core/utils/runSetupCommand.js", () => ({ runSetupCommand: vi.fn(async () => "installed") }));
import { runSetupCommand } from "../src/core/utils/runSetupCommand.js";
import { installPlaywrightChromium } from "../src/core/utils/installPlaywrightChromium.js";
test("parallel browser sessions share the same installer", async () => {
  const first = installPlaywrightChromium();
  const second = installPlaywrightChromium();
  expect(first).toBe(second);
  await Promise.all([first, second]);
  expect(runSetupCommand).toHaveBeenCalledTimes(1);
});
