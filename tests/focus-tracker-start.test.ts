import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, expect, test, vi } from "vitest";
import { gatewayBackgroundBudget } from "../src/gateway/services/gatewayBackgroundBudget.js";
import { goalHash } from "../src/gateway/services/focusTrackers.js";

// A chat is streaming (busy) and only one background slot is open, with the normal 120s grace.
vi.mock("../src/gateway/services/gatewayBackgroundBudget.js", async (original) => {
  const mod = await original<typeof import("../src/gateway/services/gatewayBackgroundBudget.js")>();
  return { ...mod, gatewayBackgroundBudget: new mod.BackgroundBudget(() => 1, () => true, () => 120_000) };
});

const root = mkdtempSync(path.join(tmpdir(), "focus-tracker-"));
const bundle = path.join(root, "bundle");
const jobDir = path.join(root, "job");
mkdirSync(bundle, { recursive: true });
mkdirSync(jobDir, { recursive: true });
writeFileSync(path.join(bundle, "track.py"), "print('ok')\n");

vi.mock("../src/core/utils/paprRoot.js", () => ({ getPaprWorkspaceDir: () => path.join(root, "workspace") }));
vi.mock("../src/gateway/utils/keyResolver.js", () => ({
  getApiKey: async (k: string) => (k === "X_AUTH_TOKEN" || k === "X_CT0" ? "set" : undefined),
}));
vi.mock("../src/gateway/services/defaultHomeBundle.js", () => ({ DEFAULT_HOME_APP_ID: "home-app" }));
vi.mock("../src/core/utils/bundledResourcesPath.js", () => ({ resolveBundledResourcesDir: async () => bundle }));

const started: string[] = [];
const created: Array<Record<string, unknown>> = [];
vi.mock("../src/gateway/services/JobsService.js", () => ({
  getJobsService: () => ({
    initialize: async () => undefined,
    getJob: async () => null,
    getJobPath: async () => jobDir,
    createJob: async (spec: Record<string, unknown>) => (created.push(spec), { id: "tracker-1" }),
    // Mirrors JobsService.runJob: every attempt is admitted through the shared budget.
    runJob: (id: string) => gatewayBackgroundBudget.run(`job:${id}`, async () => void started.push(id)),
  }),
}));

afterEach(() => vi.useRealTimers());

test("tapping Track this starts the first run now, not after the 120s maintenance grace", async () => {
  vi.useFakeTimers();
  const goal = { id: "F-1", title: "Distribution via content creation", target: "1 post on X and LinkedIn daily" };
  mkdirSync(path.join(root, "workspace", "goals"), { recursive: true });
  writeFileSync(
    path.join(root, "workspace", "goals", "trackers.json"),
    JSON.stringify({ version: 1, decisions: { [goalHash(goal)]: { template: "social-presence", p: 1 } }, links: {} }),
  );
  const { createTracker } = await import("../src/gateway/services/focusTrackers.js");

  const res = await createTracker(goal);
  await vi.advanceTimersByTimeAsync(0);

  expect(res).toEqual({ jobId: "tracker-1", kind: "script" });
  expect(created[0]).toMatchObject({ requiredKeys: ["X_AUTH_TOKEN", "X_CT0"], requirements: ["playwright", "linkedin-api"] });
  expect(existsSync(path.join(jobDir, "track.py"))).toBe(true);
  expect(started).toEqual(["tracker-1"]);
  expect(gatewayBackgroundBudget.stats().queued).toEqual([]);
});
