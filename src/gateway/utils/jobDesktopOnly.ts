/**
 * Does a job need Papr Work desktop, or can the cloud sandbox run it?
 *
 * One rule set shared by:
 *   - JobsService (auto-pins new/edited jobs to local-only, never overriding a choice)
 *   - publish/share compatibility (Hybrid badge, share-sheet warning)
 *   - the cloud "Open in Papr Work" card (via job.localOnlyReason)
 *
 * Desktop-only = the job's OWN code needs something the cloud does not have:
 * the user's Chrome (CDP :9222), macOS (osascript, EventKit), the desktop gateway
 * (localhost:18789), local Ollama, or files in the user's home folder.
 *
 * Deliberately NOT flagged (all were false positives in the first audit):
 *   - helpers Paprwork copies into every job (papr_db.py, papr_platform_browser.py)
 *     unless the job's own code calls into the browser helper
 *   - a gateway URL used only as an env-var default (cloud sets the env var)
 *   - comment lines and docstring-style prose
 *   - agent/subagent prompts — the agent can pick a cloud-safe tool instead
 */

export type DesktopOnlyKind =
  | "chrome"
  | "macos"
  | "desktop-gateway"
  | "ollama"
  | "home-files"
  | "swift"
  | "runs-desktop-job";

export interface DesktopOnlyHit {
  kind: DesktopOnlyKind;
  /** Short, user-facing reason, e.g. "Uses your Chrome". */
  reason: string;
  file: string;
  line?: number;
  snippet?: string;
}

export interface JobDesktopOnlyInput {
  id?: string;
  type: string;
  command?: string;
  provider?: string;
  /** Job's own source files, relative path → content. */
  files: Map<string, string>;
}

export const DESKTOP_ONLY_REASON: Record<DesktopOnlyKind, string> = {
  chrome: "Uses your Chrome",
  macos: "Uses macOS apps on your Mac",
  "desktop-gateway": "Talks to the Papr Work desktop app",
  ollama: "Uses a local Ollama model",
  "home-files": "Reads files on your Mac",
  swift: "Is a Swift job (macOS only)",
  "runs-desktop-job": "Runs another job that needs your Mac",
};

const HELPER_FILES = new Set([
  "papr_db.py",
  "papr_platform_browser.py",
  "papr_job_events.py",
]);
const CODE_FILE = /\.(py|js|mjs|cjs|ts|sh|bash|swift)$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.venv|venv|__pycache__|logs|data|runs|\.versions|\.git)\//;

const RULES: Array<{ kind: DesktopOnlyKind; pattern: RegExp }> = [
  {
    kind: "chrome",
    pattern:
      /connect_platform_browser\s*\(|connectOverCDP|puppeteer\.connect|:9222\b|chrome-manager|linkedin-chrome-shared/,
  },
  { kind: "desktop-gateway", pattern: /(?:localhost|127\.0\.0\.1):18789/ },
  {
    kind: "macos",
    pattern:
      /\bosascript\b|\bEventKit\b|\bicalBuddy\b|\bscreencapture\b|\bpbcopy\b|\bopen -a\b|-f\s+avfoundation\b|\bScreenCaptureKit\b|\bimport\s+(?:AVFoundation|Quartz|AppKit)\b|\bfrom\s+(?:AVFoundation|Quartz|AppKit)\s+import\b/,
  },
  { kind: "ollama", pattern: /(?:localhost|127\.0\.0\.1):11434/ },
  // Literal /Users/<name>/… path in a string.
  { kind: "home-files", pattern: /["'`]\/Users\/[A-Za-z0-9._-]+\// },
  // ~/Papr/… — the desktop workspace itself (cloud runs get their own PAPR_HOME).
  { kind: "home-files", pattern: /(?:~|\$HOME|\$\{HOME\}|Path\.home\(\)\s*\/\s*["'`])\/?Papr\// },
  // ~/Documents, $HOME/Desktop, Path.home() / "Downloads", os.path.join(HOME, "Documents") …
  {
    kind: "home-files",
    pattern:
      /(?:~|\$HOME|\$\{HOME\}|Path\.home\(\)|homedir\(\)|\bHOME\b)\s*[,+/]?\s*["'`/]*\s*(?:Documents|Desktop|Developer|Downloads|Pictures|Movies)\b/,
  },
];

/** `os.environ.get("X", "http://127.0.0.1:18789")` — cloud sets X, default never used. */
const ENV_DEFAULT =
  /(?:environ\.get|getenv|process\.env\.[A-Z_]+\s*(?:\?\?|\|\|))[^\n]{0,100}18789/;
const COMMENT_LINE = /^\s*(?:#|\/\/|\*|\/\*|""")/;
const JOB_REF = /Jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const USES_BROWSER_HELPER =
  /connect_platform_browser|from papr_platform_browser|import papr_platform_browser/;

/** Count of Python triple-quote delimiters on a line (docstrings / block strings). */
function tripleQuotes(line: string): number {
  return (line.match(/"""|\'\'\'/g) ?? []).length;
}

function scanText(text: string, file: string, hits: DesktopOnlyHit[]): void {
  const lines = text.split("\n");
  const isPython = /\.py$/i.test(file);
  let inDocstring = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isPython) {
      const quotes = tripleQuotes(line);
      // Inside a docstring, or a line that opens/closes one: prose, not code.
      if (inDocstring || quotes > 0) {
        if (quotes % 2 === 1) inDocstring = !inDocstring;
        if (/^\s*[rRbBuUfF]?("""|\'\'\')/.test(line) || inDocstring || quotes > 0 && !/=\s*[rRbBuUfF]?("""|\'\'\')/.test(line)) continue;
      }
    }
    if (COMMENT_LINE.test(line)) continue;
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      if (rule.kind === "desktop-gateway" && ENV_DEFAULT.test(line)) continue;
      hits.push({
        kind: rule.kind,
        reason: DESKTOP_ONLY_REASON[rule.kind],
        file,
        line: i + 1,
        snippet: line.trim().slice(0, 140),
      });
    }
  }
}

/** First hit per kind, in rule order. Empty array → cloud-safe. */
export function detectJobDesktopOnly(job: JobDesktopOnlyInput): DesktopOnlyHit[] {
  const hits: DesktopOnlyHit[] = [];
  if (job.type === "swift") {
    hits.push({ kind: "swift", reason: DESKTOP_ONLY_REASON.swift, file: "job.json" });
  }
  if (job.provider === "ollama") {
    hits.push({ kind: "ollama", reason: DESKTOP_ONLY_REASON.ollama, file: "job.json" });
  }
  const isAgent = job.type === "agent" || job.type === "subagent";
  if (job.command && !isAgent) scanText(job.command, "command", hits);

  let ownCode = "";
  for (const [rel, content] of job.files) {
    const base = rel.split("/").pop() ?? rel;
    if (!CODE_FILE.test(rel) || HELPER_FILES.has(base) || SKIP_DIR.test(`/${rel}`)) continue;
    ownCode += `\n${content}`;
    scanText(content, rel, hits);
  }
  if (USES_BROWSER_HELPER.test(ownCode) && !hits.some((h) => h.kind === "chrome")) {
    hits.push({ kind: "chrome", reason: DESKTOP_ONLY_REASON.chrome, file: "papr_platform_browser.py" });
  }

  const seen = new Set<DesktopOnlyKind>();
  return hits.filter((h) => (seen.has(h.kind) ? false : (seen.add(h.kind), true)));
}

/** Other jobs whose code this job runs (`…/Jobs/<uuid>/…` in its command or code). */
export function referencedJobIds(job: JobDesktopOnlyInput): string[] {
  const ids = new Set<string>();
  const texts = [job.command ?? "", ...job.files.values()];
  for (const text of texts) {
    for (const m of text.matchAll(JOB_REF)) ids.add(m[1].toLowerCase());
  }
  if (job.id) ids.delete(job.id.toLowerCase());
  return [...ids];
}

/** One short sentence for job.localOnlyReason and the cloud card. */
export function summarizeDesktopOnly(hits: DesktopOnlyHit[]): string | undefined {
  return hits[0]?.reason;
}

/** Agent-facing explanation: why it was pinned, and how to make it cloud-capable. */
export function explainDesktopOnlyForAgent(hits: DesktopOnlyHit[]): string | undefined {
  if (hits.length === 0) return undefined;
  const where = hits
    .slice(0, 3)
    .map((h) => `${h.reason.toLowerCase()} (${h.file}${h.line ? `:${h.line}` : ""})`)
    .join("; ");
  const fixes: Partial<Record<DesktopOnlyKind, string>> = {
    chrome: "use headless Playwright with vault cookie keys instead of the local Chrome",
    "desktop-gateway": "write through $APP_DB / PAPR_DB_* instead of localhost:18789",
    "home-files": "keep files in the job folder or App Files instead of your home folder",
    ollama: "use a hosted model provider",
  };
  const fix = hits.map((h) => fixes[h.kind]).filter(Boolean)[0];
  return (
    `🖥️ Set to local-only: this job ${where}. The cloud won't run it; web users get an "Open in Papr Work" prompt.` +
    (fix ? ` To make it run in the cloud, ${fix}, then update_job({ executionCapability: "local-preferred" }).` : "")
  );
}
