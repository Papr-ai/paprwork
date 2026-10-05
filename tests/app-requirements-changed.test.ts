import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const broadcast = vi.fn();
vi.mock("../src/gateway/websocket/index.js", () => ({ broadcast }));

const {
  isAppRequirementsSource,
  notifyAppRequirementsChanged,
  startJobKeysWatcher,
} = await import("../src/gateway/services/appRequirementsChanged.js");

const flush = () => new Promise((r) => setTimeout(r, 500));
const events = () =>
  broadcast.mock.calls.map((c) => c[0]).filter((e) => e.type === "app:requirements-changed");

describe("app requirements changed broadcast", () => {
  beforeEach(() => broadcast.mockClear());

  it("recognises catalog source files only", () => {
    expect(isAppRequirementsSource("requirements.json")).toBe(true);
    expect(isAppRequirementsSource("backend/manifest.json")).toBe(true);
    expect(isAppRequirementsSource("backend\\manifest.json")).toBe(true);
    expect(isAppRequirementsSource("app.ts")).toBe(false);
    expect(isAppRequirementsSource("content/requirements.json")).toBe(false);
  });

  it("debounces bursts into one broadcast per app", async () => {
    notifyAppRequirementsChanged("a");
    notifyAppRequirementsChanged("a");
    notifyAppRequirementsChanged("b");
    await flush();
    expect(events().map((e) => e.data)).toEqual([{ appId: "a" }, { appId: "b" }]);
  });

  describe("job.json watcher", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobkeys-"));
      fs.mkdirSync(path.join(dir, "job1"));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("broadcasts for the job's apps when job.json changes", async () => {
      const w = startJobKeysWatcher(dir);
      expect(w).not.toBeNull();
      await new Promise((r) => setTimeout(r, 100));
      fs.writeFileSync(
        path.join(dir, "job1", "job.json"),
        JSON.stringify({ appIds: ["app-x"], requiredKeys: ["K"] }),
      );
      await new Promise((r) => setTimeout(r, 1200));
      await w!.close();
      expect(events().some((e) => e.data?.appId === "app-x")).toBe(true);
    });

    it("ignores other files in job folders", async () => {
      const w = startJobKeysWatcher(dir);
      await new Promise((r) => setTimeout(r, 100));
      fs.writeFileSync(path.join(dir, "job1", "run.log"), "x");
      await new Promise((r) => setTimeout(r, 1200));
      await w!.close();
      expect(events()).toEqual([]);
    });
  });
});
