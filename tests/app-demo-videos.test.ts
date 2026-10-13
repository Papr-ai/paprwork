import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root = "";
vi.mock("../src/core/utils/paprRoot.js", () => ({
  getPaprDataDir: () => path.join(root, "data"),
  getPaprAppsRoot: () => path.join(root, "apps"),
}));

const demos = await import("../src/gateway/services/appDemoVideos.js");
const APP = "e6d202f3-ea1f-4717-b6da-b39481bcf227";
const SCENE = "<!doctype html><html><head></head><body><script>window.__total=4;window.__setT=()=>{};</script></body></html>";
const good = { small: [] as [string, number][], offStage: [] as string[] };

function fakeRender(checks: (typeof good)[]) {
  let n = 0;
  return vi.fn(async (p: { scenePath: string; videoPath: string; posterPath: string }) => {
    fs.writeFileSync(p.videoPath, `mp4-${n}`);
    fs.writeFileSync(p.posterPath, `jpg-${n}`);
    const check = checks[Math.min(n++, checks.length - 1)]!;
    return { seconds: 4, frames: 120, codec: "avc1", bytes: 10, check };
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50 && demos.demoStatus(APP).task?.state === "running"; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("app demo videos", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-demos-"));
    fs.mkdirSync(path.join(root, "apps", APP), { recursive: true });
    fs.writeFileSync(path.join(root, "apps", APP, "metadata.json"), JSON.stringify({ title: "SEO Audit" }));
    fs.writeFileSync(path.join(root, "apps", APP, "style.css"), ".score{font-size:14px}");
    fs.writeFileSync(path.join(root, "apps", APP, "app.ts"), "export const x = 1;");
    demos._resetDemoTasks();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("prompts with the app's metadata and source", () => {
    const prompt = demos.buildDemoScenePrompt(APP);
    expect(prompt).toContain("App: SEO Audit");
    expect(prompt).toContain("===== style.css =====");
    expect(prompt).toContain("===== app.ts =====");
  });

  it("injects the app CSS and rejects scenes without a clock", () => {
    expect(demos.normalizeScene(APP, "```html\n" + SCENE + "\n```")).toContain('<style id="app-css">.score{font-size:14px}</style>');
    expect(() => demos.normalizeScene(APP, "<html><body>hi</body></html>")).toThrow(/__setT/);
  });

  it("writes, records and stores privately; one take when the check passes", async () => {
    const writeScene = vi.fn(async () => SCENE);
    const render = fakeRender([good]);
    demos.startDemoGeneration(APP, { writeScene, render });
    await settle();
    expect(demos.demoStatus(APP)).toMatchObject({ exists: true, task: { state: "done" } });
    expect(writeScene).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(demos.demoPaths(APP).video, "utf8")).toBe("mp4-0");
    expect(fs.existsSync(path.join(root, "apps", APP, `${APP}.mp4`))).toBe(false);
    expect(demos.listDemoAppIds()).toEqual([APP]);
    expect(fs.readdirSync(demos.demoDir()).sort()).toEqual([`${APP}.html`, `${APP}.jpg`, `${APP}.mp4`]);
  });

  it("retries once with feedback when text is too small and keeps the better take", async () => {
    const small: [string, number][] = [["Crawlability", 12], ["On-Page", 13], ["/ 100", 11], ["Links", 10]];
    const writeScene = vi.fn(async () => SCENE);
    const render = fakeRender([{ small, offStage: [] }, good]);
    demos.startDemoGeneration(APP, { writeScene, render });
    await settle();
    expect(writeScene).toHaveBeenCalledTimes(2);
    expect(writeScene.mock.calls[1]![1]).toMatch(/too small to read.*"Crawlability" \(12px\)/s);
    expect(fs.readFileSync(demos.demoPaths(APP).video, "utf8")).toBe("mp4-1");
  });

  it("keeps the previous video when generation fails", async () => {
    demos.startDemoGeneration(APP, { writeScene: async () => SCENE, render: fakeRender([good]) });
    await settle();
    demos.startDemoGeneration(APP, { writeScene: async () => "no html here", render: fakeRender([good]) });
    await settle();
    expect(demos.demoStatus(APP)).toMatchObject({ exists: true, task: { state: "failed" } });
    expect(fs.readFileSync(demos.demoPaths(APP).video, "utf8")).toBe("mp4-0");
  });

  it("joins a run already in progress instead of starting another", () => {
    const writeScene = vi.fn(() => new Promise<string>(() => undefined));
    const a = demos.startDemoGeneration(APP, { writeScene, render: fakeRender([good]) });
    const b = demos.startDemoGeneration(APP, { writeScene, render: fakeRender([good]) });
    expect(b).toBe(a);
  });

  it("shares the video + poster as App Files and points papr-cover.json at them", async () => {
    demos.startDemoGeneration(APP, { writeScene: async () => SCENE, render: fakeRender([good]) });
    await settle();
    const upload = vi.fn(async ({ fileName }: { fileName: string }) => ({
      id: fileName, objectKey: `k/${fileName}`, url: `https://files.papr.ai/${fileName}`,
    }));
    expect(await demos.shareDemoVideo(APP, upload)).toEqual({
      shared: true, url: "https://files.papr.ai/preview.jpg", videoUrl: "https://files.papr.ai/preview.mp4",
    });
    const pointer = JSON.parse(fs.readFileSync(path.join(root, "apps", APP, "papr-cover.json"), "utf8"));
    expect(pointer).toMatchObject({ kind: "video", url: "https://files.papr.ai/preview.jpg", videoUrl: "https://files.papr.ai/preview.mp4" });
    expect(demos.sharedCoverKind(APP)).toBe("video");
  });
});
