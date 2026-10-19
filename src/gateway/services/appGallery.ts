/**
 * App gallery from the app's REAL components.
 *
 * Every app can carry its gallery in its own code: gallery/index.ts (plus helpers such
 * as gallery/data.ts). It imports the app's own modules, fakes the backend with sample
 * data through the Papr gallery kit (src/resources/gallery-kit/papr-gallery.ts) and lays
 * out the scenes with film(). Papr bundles it into one page that the demo recorder films
 * exactly like a written scene (window.__total / window.__setT), so the video, the
 * gallery screens and sharing (App Files) work unchanged.
 *
 * The folder is optional source: the agent writes it on first Generate and edits it on
 * Revise; owners who want to can edit it by hand. If it's there, it's what gets filmed.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { getPaprAppsRoot } from "../../core/utils/paprRoot.js";

export const GALLERY_DIR = "gallery";
export const GALLERY_ENTRY = "index.ts";
/** Gallery files the agent may write: gallery/<name>.ts(x)|.css, flat. */
const FILE_RE = /^gallery\/[A-Za-z0-9_-]+\.(ts|tsx|css)$/;
const MAX_FILES = 6;
const MAX_FILE_BYTES = 40_000;

export interface GalleryFile {
  path: string;
  content: string;
}

function appDir(appId: string): string {
  return path.join(getPaprAppsRoot(), appId);
}

/** Where a take's gallery lives: gallery/ (the app's) or a sibling staging folder. */
export function galleryPath(appId: string, take = ""): string {
  return path.join(appDir(appId), take ? `.gallery-${take}` : GALLERY_DIR);
}

export function hasGallery(appId: string, take = ""): boolean {
  return fs.existsSync(path.join(galleryPath(appId, take), GALLERY_ENTRY));
}

export function kitDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(here, "../../resources/gallery-kit");
  return dir.includes(`app.asar${path.sep}`) ? dir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : dir;
}

function sdkDir(): string {
  const dir = path.join(kitDir(), "../mini-app-sdk");
  return dir;
}

/** The kit's source, shown to the agent as the API it writes against. */
export function kitSource(): string {
  return fs.readFileSync(path.join(kitDir(), "papr-gallery.ts"), "utf8");
}

/** Validate the agent's files: only flat gallery/*.ts|tsx|css, bounded, with an entry. */
export function normalizeGalleryFiles(raw: unknown): GalleryFile[] {
  const list = (raw as { files?: unknown[] } | null)?.files;
  if (!Array.isArray(list)) throw new Error("The model returned no gallery files.");
  const out: GalleryFile[] = [];
  for (const f of list) {
    const p = String((f as GalleryFile)?.path ?? "").trim().replace(/^\.?\//, "");
    const content = (f as GalleryFile)?.content;
    if (!FILE_RE.test(p) || typeof content !== "string" || !content.trim()) continue;
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error(`${p} is too large.`);
    if (!out.some((x) => x.path === p)) out.push({ path: p, content });
  }
  if (!out.some((f) => f.path === `${GALLERY_DIR}/${GALLERY_ENTRY}`)) throw new Error("The gallery has no gallery/index.ts.");
  return out.slice(0, MAX_FILES);
}

/** Replace a take's gallery folder with these files. */
export function writeGalleryFiles(appId: string, take: string, files: GalleryFile[]): void {
  const dir = galleryPath(appId, take);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, path.basename(f.path)), f.content);
}

/** The gallery's current files as gallery/<name> (for edit prompts). */
export function readGalleryFiles(appId: string, take = ""): GalleryFile[] {
  const dir = galleryPath(appId, take);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(ts|tsx|css)$/.test(f))
    .sort((a, b) => Number(b === GALLERY_ENTRY) - Number(a === GALLERY_ENTRY) || a.localeCompare(b))
    .map((f) => ({ path: `${GALLERY_DIR}/${f}`, content: fs.readFileSync(path.join(dir, f), "utf8") }));
}

/** Make a staging take the app's gallery/ (the winner of a run). */
export function promoteGallery(appId: string, take: string): void {
  const from = galleryPath(appId, take);
  if (!fs.existsSync(from)) return;
  const to = galleryPath(appId);
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
}

export function dropGalleryTakes(appId: string): void {
  for (const take of ["a", "b"]) fs.rmSync(galleryPath(appId, take), { recursive: true, force: true });
}

/** The app's own stylesheets, in the order index.html loads them (local files only). */
export function appStylesheets(appId: string): string {
  const dir = appDir(appId);
  let html = "";
  try {
    html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  } catch {
    /* no index.html */
  }
  const hrefs = [...html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)]
    .map((m) => /href=["']([^"']+)["']/i.exec(m[0])?.[1] ?? "")
    .filter((h) => h && !/^(https?:)?\/\//i.test(h) && !h.startsWith("/"));
  const files = hrefs.length ? hrefs : ["dist/app.css", "style.css", "styles.css"];
  let css = "";
  for (const rel of files) {
    const p = path.resolve(dir, rel.split(/[?#]/)[0]!);
    if (!p.startsWith(dir) || !fs.existsSync(p)) continue;
    css += `\n/* ${rel} */\n${fs.readFileSync(p, "utf8")}`;
  }
  return css;
}

const FONT_HOSTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
// Ask for woff2 (the CSS API serves formats by user agent).
const FONT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * The app's web fonts (Google Fonts links in index.html), inlined as data URIs so the
 * offline recorder draws the real typeface. Cached per stylesheet URL; on failure the
 * families fall back to the system UI font instead of the browser's serif default.
 */
async function appFonts(appId: string): Promise<string> {
  let html = "";
  try {
    html = fs.readFileSync(path.join(appDir(appId), "index.html"), "utf8");
  } catch {
    return "";
  }
  const links = [...html.matchAll(/<link[^>]+href=["'](https:\/\/fonts\.googleapis\.com\/[^"']+)["'][^>]*>/gi)]
    .map((m) => m[1]!.replace(/&amp;/g, "&"))
    .filter((u) => /rel=["']?stylesheet/i.test(html.slice(html.indexOf(u) - 200, html.indexOf(u) + u.length + 200)) || /css2?\?/.test(u));
  let css = "";
  const families = new Set<string>();
  for (const url of links.slice(0, 3)) {
    for (const f of url.matchAll(/family=([^&:]+)/g)) families.add(decodeURIComponent(f[1]!.replace(/\+/g, " ")));
    const cacheDir = path.join(getPaprAppsRoot(), "..", "data", "demos", "fonts");
    const key = Buffer.from(url).toString("base64url").slice(0, 120);
    const cached = path.join(cacheDir, `${key}.css`);
    try {
      if (fs.existsSync(cached)) {
        css += fs.readFileSync(cached, "utf8");
        continue;
      }
      const full = await (await fetch(url, { headers: { "User-Agent": FONT_UA }, signal: AbortSignal.timeout(8000) })).text();
      // Keep the Latin subsets (sample data is written in English); others stay system fonts.
      const blocks = full.split(/(?=\/\* [a-z-]+ \*\/)/);
      const latin = blocks.filter((b) => /^\/\* latin(-ext)? \*\//.test(b));
      const sheet = latin.length ? latin.join("") : full;
      let out = sheet;
      for (const m of sheet.matchAll(/url\((https:[^)]+)\)/g)) {
        if (!FONT_HOSTS.test(m[1]!)) continue;
        const buf = Buffer.from(await (await fetch(m[1]!, { signal: AbortSignal.timeout(8000) })).arrayBuffer());
        out = out.replace(m[1]!, `data:font/woff2;base64,${buf.toString("base64")}`);
      }
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cached, out);
      css += out;
    } catch {
      /* offline: fall back below */
    }
  }
  if (!css && families.size) {
    css = [...families].map((f) => `@font-face{font-family:"${f}";src:local("SF Pro Text"),local("Helvetica Neue"),local("Arial")}`).join("\n");
  }
  return css;
}

/** The theme the app sets on <html> before first paint (data-theme etc.), if it's static. */
function htmlAttrs(appId: string): string {
  try {
    const html = fs.readFileSync(path.join(appDir(appId), "index.html"), "utf8");
    const m = /<html([^>]*)>/i.exec(html);
    return (m?.[1] ?? "").replace(/\s+lang=["'][^"']*["']/i, "");
  } catch {
    return "";
  }
}

export interface GalleryBuild {
  html: string;
  warnings: string[];
}

/**
 * Bundle a take's gallery/index.ts with the app's modules into one self-contained page.
 * /__papr__/papr-gallery.ts is the kit; other /__papr__/ SDK modules are bundled in.
 * Throws with readable esbuild errors (file:line) the agent can fix.
 */
export async function buildGallery(appId: string, take = ""): Promise<GalleryBuild> {
  const dir = galleryPath(appId, take);
  const entry = path.join(dir, GALLERY_ENTRY);
  if (!fs.existsSync(entry)) throw new Error("No gallery/index.ts.");
  const kit = kitDir();
  const sdk = sdkDir();
  const esbuild = await import("esbuild");
  const resolver: import("esbuild").Plugin = {
    name: "papr-gallery",
    setup(build) {
      build.onResolve({ filter: /^\/__papr__\// }, (args) => {
        const name = path.basename(args.path).replace(/\.js$/, ".ts");
        const file = name === "papr-gallery.ts" ? path.join(kit, name) : path.join(sdk, name);
        if (!fs.existsSync(file)) return { errors: [{ text: `Unknown Papr module ${args.path}` }] };
        return { path: file };
      });
    },
  };
  let out: import("esbuild").BuildResult & { outputFiles: import("esbuild").OutputFile[] };
  try {
    out = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      outdir: path.join(dir, ".out"),
      absWorkingDir: appDir(appId),
      format: "esm",
      platform: "browser",
      target: "es2020",
      logLevel: "silent",
      loader: { ".ts": "ts", ".tsx": "tsx", ".css": "css", ".svg": "text", ".png": "dataurl", ".jpg": "dataurl" },
      plugins: [resolver],
    });
  } catch (err) {
    const e = err as { errors?: Array<{ text: string; location?: { file: string; line: number; lineText?: string } | null }>; message: string };
    const lines = (e.errors ?? []).slice(0, 6).map((x) => {
      const loc = x.location ? ` (${path.relative(appDir(appId), path.resolve(appDir(appId), x.location.file)).replace(`.gallery-${take}`, GALLERY_DIR)}:${x.location.line})` : "";
      return `${x.text}${loc}`;
    });
    throw new Error(`The gallery does not build:\n${lines.join("\n") || e.message}`);
  }
  const js = out.outputFiles.filter((f) => f.path.endsWith(".js")).map((f) => f.text).join("\n");
  const bundledCss = out.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
  const css = `${await appFonts(appId)}\n${appStylesheets(appId)}\n${bundledCss}`.replace(/<\/style/gi, "<\\/style");
  const safeJs = js.replace(/<\/script/gi, "<\\/script");
  const html = `<!doctype html><html${htmlAttrs(appId)}><head><meta charset="utf-8"><style id="app-css">${css}</style></head><body><script type="module">${safeJs}</script></body></html>`;
  return { html, warnings: (out.warnings ?? []).slice(0, 5).map((w) => w.text) };
}
