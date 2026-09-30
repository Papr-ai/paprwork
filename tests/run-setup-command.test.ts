import { expect, test } from "vitest";
import { runSetupCommand } from "../src/core/utils/runSetupCommand.js";
const command = (code: string) => `"${process.execPath}" -e '${code}'`;
test("setup lets gateway timers run and captures output", async () => {
  let ticks = 0; const timer = setInterval(() => ticks++, 10);
  try {
    const result = await runSetupCommand(command('setTimeout(() => console.log("done"), 150)'), { timeout: 5000 });
    expect(result).toContain("done"); expect(ticks).toBeGreaterThan(2);
  } finally { clearInterval(timer); }
});
test("timeout, cancellation and failure reject without hanging", async () => {
  await expect(runSetupCommand(command('setInterval(() => {}, 1000)'), { timeout: 80 })).rejects.toThrow("timed out");
  const controller = new AbortController();
  const promise = runSetupCommand(command('setInterval(() => {}, 1000)'), { signal: controller.signal });
  const rejected = expect(promise).rejects.toThrow("cancelled"); controller.abort(); await rejected;
  await expect(runSetupCommand(command('process.exit(2)'))).rejects.toThrow("exited 2");
});
