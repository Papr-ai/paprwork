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
const store = await import("../src/gateway/services/appDemoStore.js");
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
    expect(fs.readdirSync(demos.demoDir()).sort()).toEqual([
      `${APP}.html`, `${APP}.jpg`, `${APP}.json`, `${APP}.mp4`, `${APP}.v1.html`, `${APP}.v1.jpg`, `${APP}.v1.mp4`,
    ]);
    expect(demos.demoStatus(APP)).toMatchObject({ current: 1, versions: [{ v: 1, kind: "create" }] });
  });

  it("retries once with feedback when text is too small and keeps the better take", async () => {
    const small: [string, number][] = [["Crawlability", 12], ["On-Page", 13], ["/ 100", 11], ["Links", 10]];
    const writeScene = vi.fn(async () => SCENE);
    const render = fakeRender([{ small, offStage: [] }, good]);
    demos.startDemoGeneration(APP, { writeScene, render });
    await settle();
    expect(writeScene).toHaveBeenCalledTimes(2);
    expect(writeScene.mock.calls[1]![1]).toMatch(/too small to read.*"Crawlability" \(12px\)/s);
    // Polish edits the first scene instead of starting over.
    expect(writeScene.mock.calls[1]![1]).toContain("CURRENT SCENE (edit this one; do not start over)");
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

  it("reviews three frames next to the real app and polishes from what it saw", async () => {
    fs.mkdirSync(path.join(root, "data", "covers"), { recursive: true });
    // A real screenshot of the app (PNG magic) becomes the fidelity reference.
    fs.writeFileSync(path.join(root, "data", "covers", `${APP}.img`), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const writeScene = vi.fn(async () => SCENE);
    const stills = vi.fn(async (_scene: string, s: { t: number; path: string }[]) => {
      s.forEach((x) => fs.writeFileSync(x.path, "jpg"));
      return s.map((x) => ({ t: x.t, path: x.path }));
    });
    const reviews = [
      { fidelity: 2, polish: 4, problems: [{ frame: 2, what: "Score ring is empty", fix: "Fill it to 82" }] },
      { fidelity: 5, polish: 5, problems: [] },
    ];
    let r = 0;
    const review = vi.fn(async () => reviews[r++]);
    demos.startDemoGeneration(APP, { writeScene, render: fakeRender([good]), stills, review });
    await settle();
    expect(demos.demoStatus(APP).task).toMatchObject({ state: "done", version: 1 });
    const [prompt, images] = review.mock.calls[0]! as unknown as [string, string[]];
    expect(prompt).toMatch(/screenshot of the real app/);
    expect(prompt).toMatch(/copied from the reference/);
    expect(images).toHaveLength(4);
    expect(images[0]).toMatch(/\.ref\.png$/);
    expect(writeScene).toHaveBeenCalledTimes(2);
    expect(writeScene.mock.calls[1]![1]).toMatch(/at 1\.8s: Score ring is empty → Fill it to 82/);
    expect(writeScene.mock.calls[1]![1]).toMatch(/Fidelity 2\/5/);
    expect(demos.demoStatus(APP).versions[0]).toMatchObject({ fidelity: 5, polish: 5 });
    // Scratch frames and the reference copy are gone.
    expect(fs.readdirSync(demos.demoDir()).some((f) => f.includes(".still-") || f.includes(".ref."))).toBe(false);
  });

  it("notes → one revise edits the current scene, makes v2 and marks the notes fixed", async () => {
    demos.startDemoGeneration(APP, { writeScene: async () => SCENE, render: fakeRender([good]) });
    await settle();
    const pinned = store.addNote(APP, { t: 1.24, x: 0.5, y: 0.25, body: "Make the score bigger" });
    store.addNote(APP, { t: 3, body: "End on the list, not the chart" });
    expect(pinned).toMatchObject({ v: 1, t: 1.2, x: 0.5, y: 0.25 });
    const writeScene = vi.fn(async () => SCENE.replace("__total=4", "__total=4.5"));
    const stills = vi.fn(async (_scene: string, s: { t: number; path: string; probe?: unknown }[]) =>
      s.map((x) => ({ t: x.t, path: x.path, probe: x.probe ? { element: "div.score", text: "82", path: "div.score < div.card" } : undefined })));
    demos.startDemoRevision(APP, { writeScene, render: fakeRender([good]), stills });
    await settle();
    const st = demos.demoStatus(APP);
    expect(st).toMatchObject({ current: 2, task: { state: "done", kind: "revise", version: 2 } });
    expect(st.versions.map((v) => v.v)).toEqual([1, 2]);
    expect(st.notes.every((n) => n.fixedIn === 2)).toBe(true);
    const [, prompt, images] = writeScene.mock.calls[0]! as unknown as [string, string, string[]];
    expect(prompt).toContain("CURRENT SCENE (edit this one; do not start over)");
    expect(prompt).toMatch(/At 1\.2s \(image 1\) pinned at x=50%, y=25% on div\.score < div\.card \("82"\): Make the score bigger/);
    expect(prompt).toMatch(/At 3\.0s \(image 2\): End on the list/);
    expect(images).toHaveLength(2);
    expect(stills.mock.calls[0]![1][0]).toMatchObject({ probe: { x: 0.5, y: 0.25 } });
    // v1 is kept; the in-use copy is v2.
    expect(fs.existsSync(store.demoPaths(APP, "v1").video)).toBe(true);
    expect(fs.readFileSync(demos.demoPaths(APP).scene, "utf8")).toContain("__total=4.5");
  });

  it("can go back to an older version, and won't revise without notes", async () => {
    demos.startDemoGeneration(APP, { writeScene: async () => SCENE, render: fakeRender([good]) });
    await settle();
    expect(() => demos.startDemoRevision(APP, { writeScene: async () => SCENE, render: fakeRender([good]) })).toThrow(/Add a note/);
    store.addNote(APP, { t: 1, body: "Slower" });
    demos.startDemoRevision(APP, { writeScene: async () => SCENE.replace("__total=4", "__total=5"), render: fakeRender([good]) });
    await settle();
    expect(demos.demoStatus(APP).current).toBe(2);
    store.setCurrentVersion(APP, 1);
    expect(demos.demoStatus(APP).current).toBe(1);
    expect(fs.readFileSync(demos.demoPaths(APP).scene, "utf8")).not.toContain("__total=5");
    expect(() => store.setCurrentVersion(APP, 9)).toThrow(/No such version/);
  });

  it("treats a video made before versions existed as v1", () => {
    fs.mkdirSync(demos.demoDir(), { recursive: true });
    for (const f of Object.values(demos.demoPaths(APP))) fs.writeFileSync(f, "old");
    expect(store.readManifest(APP)).toMatchObject({ current: 1, versions: [{ v: 1 }], notes: [] });
    expect(fs.readFileSync(store.demoPaths(APP, "v1").video, "utf8")).toBe("old");
  });

  it("only deletes open notes and rejects empty ones", async () => {
    demos.startDemoGeneration(APP, { writeScene: async () => SCENE, render: fakeRender([good]) });
    await settle();
    expect(() => store.addNote(APP, { t: 1, body: "   " })).toThrow(/Write what should change/);
    const n = store.addNote(APP, { t: 1, body: "x", x: 4, y: -1 });
    expect(n).toMatchObject({ x: 1, y: 0 });
    expect(store.deleteNote(APP, n.id)).toBe(true);
    expect(store.deleteNote(APP, n.id)).toBe(false);
  });

  it("makes five captioned, cropped screens after the video and keeps them per version", async () => {
    const stills = vi.fn(async (_scene: string, s: { t: number; path: string; crop?: unknown }[]) => {
      s.forEach((x) => fs.writeFileSync(x.path, x.crop ? "crop" : "jpg"));
      return s.map((x) => ({ t: x.t, path: x.path }));
    });
    const pickScreens = vi.fn(async () => ({
      screens: [1, 3, 5, 7, 8, 2].map((frame, i) => ({
        frame,
        crop: { x: 0.9, y: 0, w: 0.1, h: 0.5 },
        caption: i === 0 ? "  Every check at a glance.  " : `Screen ${i + 1}`,
        why: "",
      })),
    }));
    demos.startDemoGeneration(APP, { writeScene: async () => SCENE, render: fakeRender([good]), stills, pickScreens });
    await settle();
    const st = demos.demoStatus(APP);
    expect(st.task).toMatchObject({ state: "done", version: 1 });
    const screens = st.versions[0]!.screens!;
    expect(screens).toHaveLength(5);
    expect(screens[0]).toMatchObject({ caption: "Every check at a glance", t: 0.5 });
    // Too-narrow crops are widened and kept inside the frame.
    expect(screens[0]!.crop.w).toBeGreaterThanOrEqual(0.25);
    expect(screens[0]!.crop.x + screens[0]!.crop.w).toBeLessThanOrEqual(1);
    expect(fs.readFileSync(store.screenPath(APP, 1, 5), "utf8")).toBe("crop");
    expect((pickScreens.mock.calls[0] as unknown as [string, string[]])[1]).toHaveLength(8);
    // New gallery = not reviewed yet; opening it clears that.
    expect(st.seen).toBe(0);
    expect(store.markSeen(APP).seen).toBe(1);
  });

  it("screen comments drive the next version; at least four screens stay in", async () => {
    const stills = vi.fn(async (_scene: string, s: { t: number; path: string }[]) => {
      s.forEach((x) => fs.writeFileSync(x.path, "jpg"));
      return s.map((x) => ({ t: x.t, path: x.path }));
    });
    const pickScreens = vi.fn(async () => ({
      screens: [1, 2, 3, 4, 5].map((frame) => ({ frame, crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, caption: `Cap ${frame}`, why: "" })),
    }));
    const deps = { writeScene: vi.fn(async () => SCENE), render: fakeRender([good]), stills, pickScreens };
    demos.startDemoGeneration(APP, deps);
    await settle();
    expect(store.updateScreen(APP, 2, { hidden: true }).versions[0]!.screens![1]!.hidden).toBe(true);
    expect(() => store.updateScreen(APP, 3, { hidden: true })).toThrow(/at least 4/);
    expect(store.updateScreen(APP, 1, { caption: "Send a fix to your team." }).versions[0]!.screens![0]!.caption).toBe("Send a fix to your team");
    expect(store.addNote(APP, { t: 3, on: 2, body: "Crop tighter on the list" })).toMatchObject({ on: 2, t: 0 });
    demos.startDemoRevision(APP, deps);
    await settle();
    const prompt = deps.writeScene.mock.calls[1] as unknown as [string, string];
    expect(prompt[1]).toMatch(/On gallery screen 2 "Cap 2" \(image 1, at 1\.0s/);
    expect((pickScreens.mock.calls[1] as unknown as [string])[0]).toMatch(/Screen 2: Crop tighter on the list/);
    expect(demos.demoStatus(APP).versions[1]!.screens).toHaveLength(5);
  });

  it("a failed screen pick never fails the video", async () => {
    const stills = vi.fn(async () => { throw new Error("no window"); });
    demos.startDemoGeneration(APP, { writeScene: async () => SCENE, render: fakeRender([good]), stills, pickScreens: async () => ({}) });
    await settle();
    expect(demos.demoStatus(APP)).toMatchObject({ exists: true, task: { state: "done" }, current: 1 });
    expect(demos.demoStatus(APP).versions[0]!.screens).toBeUndefined();
  });

  it("Download all copies the video and the kept screens, numbered", async () => {
    const { exportGallery } = await import("../src/gateway/services/appDemoExport.js");
    const stills = vi.fn(async (_scene: string, s: { t: number; path: string }[]) => {
      s.forEach((x) => fs.writeFileSync(x.path, "jpg"));
      return s.map((x) => ({ t: x.t, path: x.path }));
    });
    const pickScreens = async () => ({
      screens: [1, 2, 3, 4, 5].map((frame) => ({ frame, crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, caption: `Cap/${frame}`, why: "" })),
    });
    demos.startDemoGeneration(APP, { writeScene: async () => SCENE, render: fakeRender([good]), stills, pickScreens });
    await settle();
    store.updateScreen(APP, 3, { hidden: true });
    const out = exportGallery(APP, path.join(root, "dl"));
    expect(out.folder).toBe(path.join(root, "dl", "SEO Audit gallery"));
    expect(out.files).toEqual(["0 Preview.mp4", "1 Cap 1.jpg", "2 Cap 2.jpg", "3 Cap 4.jpg", "4 Cap 5.jpg"]);
  });
});
