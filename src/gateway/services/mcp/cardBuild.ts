/**
 * Publish-time card builder: metadata.claude.views → dist/cards/{view}.html.
 *
 * Each card is ONE self-contained HTML file (MCP Apps hosts load a single resource,
 * no relative assets): card kit + transport + bridge + the view code, inlined and
 * minified. No external scripts, so no CSP resourceDomains are needed.
 *
 *   default view (status/action/approval) → generated entry calling papr-card-views
 *   custom view (entry: cards/inbox.ts)   → bundled as-is; may import any /__papr__/ module
 *
 * dist/cards/cards.json lists the views for the MCP server (titles, kinds, actions).
 */
import { existsSync, promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { AppBackendActionSpec, AppBackendManifest } from "../../../core/types/appBackend.js";
import { parseAppBackendManifest } from "../appRuntime/appBackendManifest.js";
import { checkViewsAgainstBackend, parseClaudeAppConfig, type ClaudeAppConfig, type ClaudeCardView } from "./cardContract.js";

export const CARD_SOFT_LIMIT_BYTES = 150_000;
export const CARD_HARD_LIMIT_BYTES = 1_000_000;

export interface BuiltCard {
  view: string;
  file: string;
  bytes: number;
}

export interface CardBuildResult {
  /** False when the app hasn't opted in (no files written, stale cards removed). */
  enabled: boolean;
  success: boolean;
  errors: string[];
  warnings: string[];
  cards: BuiltCard[];
}

/** The backend action a view runs, copied in so the MCP server needn't parse the manifest. */
export interface CardViewAction {
  name: string;
  description?: string;
  effect?: AppBackendActionSpec["effect"];
  runsOn?: AppBackendActionSpec["runsOn"];
  input?: AppBackendActionSpec["input"];
}

export interface CardsManifestView extends ClaudeCardView {
  file: string;
  bytes: number;
  actionSpec?: CardViewAction;
}

export interface CardsManifest {
  version: 1;
  summary?: string;
  whenToUse?: string;
  examples?: string[];
  views: Record<string, CardsManifestView>;
}

export function viewActionSpec(view: ClaudeCardView, manifest: AppBackendManifest | null): CardViewAction | undefined {
  const name = view.action;
  const a = name ? manifest?.actions[name] : undefined;
  if (!name || !a) return undefined;
  return {
    name,
    ...(a.description ? { description: a.description } : {}),
    ...(a.effect ? { effect: a.effect } : {}),
    ...(a.runsOn ? { runsOn: a.runsOn } : {}),
    ...(a.input ? { input: a.input } : {}),
  };
}

function resolveSdkDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(here, "../../../resources/mini-app-sdk");
  return dir.includes(`app.asar${path.sep}`) ? dir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : dir;
}

/** Default views compile from a generated entry; custom views use the author's file. */
export function defaultViewEntry(view: ClaudeCardView, manifest: AppBackendManifest | null): string {
  const spec = (name: string | undefined) => {
    const a = name ? manifest?.actions[name] : undefined;
    if (!name || !a) return undefined;
    return { action: name, effect: a.effect, runsOn: a.runsOn, input: a.input };
  };
  const json = (v: unknown): string => JSON.stringify(v ?? null);
  switch (view.kind) {
    case "status":
      return `import { statusView } from "/__papr__/papr-card-views.ts";\nstatusView({ from: ${json(view.from)}, primary: ${json(spec(view.action))} ?? undefined });\n`;
    case "action":
      return `import { actionView } from "/__papr__/papr-card-views.ts";\nactionView(${json(spec(view.action))});\n`;
    case "approval":
      return `import { approvalView } from "/__papr__/papr-card-views.ts";\napprovalView(${json(spec(view.action))});\n`;
    default:
      throw new Error("not a default view");
  }
}

export function cardHtml(title: string, js: string): string {
  const safeJs = js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
  const safeTitle = title.replace(/[<>&"]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title></head><body><div id="papr-card"></div><script type="module">${safeJs}</script></body></html>`;
}

/** Fails cards that would need network-loaded code (blocked by host CSP anyway). */
export function checkCardHtml(view: string, html: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (/<script[^>]+\bsrc\s*=/i.test(html)) errors.push(`card "${view}": external <script src> is not allowed; import it so it's bundled`);
  if (/<link[^>]+rel=["']?stylesheet/i.test(html)) errors.push(`card "${view}": external stylesheets are not allowed; inline the CSS`);
  const bytes = Buffer.byteLength(html);
  if (bytes > CARD_HARD_LIMIT_BYTES) errors.push(`card "${view}" is ${Math.round(bytes / 1024)} KB (limit ${CARD_HARD_LIMIT_BYTES / 1000} KB)`);
  else if (bytes > CARD_SOFT_LIMIT_BYTES) warnings.push(`card "${view}" is ${Math.round(bytes / 1024)} KB; cards load fastest under ${CARD_SOFT_LIMIT_BYTES / 1000} KB`);
  return { errors, warnings };
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path.basename(file)}: ${(err as Error).message}`);
  }
}

async function bundleView(appDir: string, sdkDir: string, name: string, view: ClaudeCardView, manifest: AppBackendManifest | null): Promise<string> {
  const esbuild = await import("esbuild");
  const sdk: import("esbuild").Plugin = {
    name: "papr-card-sdk",
    setup(build) {
      // In a card the SDK is bundled in (one file), unlike app dist where it is runtime-served.
      build.onResolve({ filter: /^\/__papr__\// }, (args) => {
        const file = path.join(sdkDir, path.basename(args.path).replace(/\.js$/, ".ts"));
        if (!file.startsWith(sdkDir) || !existsSync(file)) return { errors: [{ text: `Unknown Papr SDK module ${args.path}` }] };
        return { path: file };
      });
    },
  };
  const entry = view.entry
    ? { entryPoints: [path.join(appDir, view.entry)] }
    : { stdin: { contents: defaultViewEntry(view, manifest), resolveDir: appDir, sourcefile: `${name}.card.ts`, loader: "ts" as const } };
  const out = await esbuild.build({
    ...entry,
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    plugins: [sdk],
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

export async function buildAppCards(appDir: string, opts: { sdkDir?: string } = {}): Promise<CardBuildResult> {
  const result: CardBuildResult = { enabled: false, success: true, errors: [], warnings: [], cards: [] };
  const outDir = path.join(appDir, "dist", "cards");
  let cfg: ClaudeAppConfig | null;
  let manifest: AppBackendManifest | null = null;
  try {
    const metadata = await readJson(path.join(appDir, "metadata.json"));
    cfg = parseClaudeAppConfig(metadata);
    if (cfg) {
      const rawManifest = await readJson(path.join(appDir, "backend", "manifest.json"));
      manifest = rawManifest ? parseAppBackendManifest(rawManifest) : null;
    }
  } catch (err) {
    return { ...result, enabled: true, success: false, errors: [(err as Error).message] };
  }
  if (!cfg) {
    await fs.rm(outDir, { recursive: true, force: true });
    return result;
  }
  result.enabled = true;
  result.errors.push(...checkViewsAgainstBackend(cfg, manifest));
  if (Object.keys(cfg.views).length === 0) result.warnings.push("metadata.claude has no views; Claude will only see tools");
  if (result.errors.length) return { ...result, success: false };

  const sdkDir = opts.sdkDir ?? resolveSdkDir();
  const built: Array<{ name: string; view: ClaudeCardView; html: string }> = [];
  for (const [name, view] of Object.entries(cfg.views)) {
    try {
      const js = await bundleView(appDir, sdkDir, name, view, manifest);
      const html = cardHtml(view.title ?? name, js);
      const check = checkCardHtml(name, html);
      result.errors.push(...check.errors);
      result.warnings.push(...check.warnings);
      built.push({ name, view, html });
    } catch (err) {
      const e = err as { errors?: Array<{ text: string; location?: { file: string; line: number } }>; message: string };
      const first = e.errors?.[0];
      result.errors.push(`card "${name}": ${first ? `${first.text}${first.location ? ` (${first.location.file}:${first.location.line})` : ""}` : e.message}`);
    }
  }
  if (result.errors.length) return { ...result, success: false };

  // Replace the whole directory so removed views don't linger as reachable cards.
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const cardsManifest: CardsManifest = {
    version: 1,
    ...(cfg.summary ? { summary: cfg.summary } : {}),
    ...(cfg.whenToUse ? { whenToUse: cfg.whenToUse } : {}),
    ...(cfg.examples ? { examples: cfg.examples } : {}),
    views: {},
  };
  for (const { name, view, html } of built) {
    const file = `${name}.html`;
    await fs.writeFile(path.join(outDir, file), html);
    const bytes = Buffer.byteLength(html);
    const actionSpec = viewActionSpec(view, manifest);
    cardsManifest.views[name] = { ...view, file, bytes, ...(actionSpec ? { actionSpec } : {}) };
    result.cards.push({ view: name, file: `dist/cards/${file}`, bytes });
  }
  await fs.writeFile(path.join(outDir, "cards.json"), JSON.stringify(cardsManifest, null, 2) + "\n");
  return result;
}
