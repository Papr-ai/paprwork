/**
 * Scan mini-apps (and linked jobs) for cloud publish compatibility.
 */

import type {
  CloudCompatibilityCategory,
  CloudCompatibilityFinding,
  CloudCompatibilityLevel,
  CloudCompatibilityReport,
} from "../../core/types/cloudAppCompatibility.js";

const SOURCE_FILE = /\.(html|css|tsx?|jsx?|json)$/i;

const DESKTOP_ONLY_CATEGORIES = new Set<CloudCompatibilityCategory>([
  "papr-api",
  "localhost-gateway",
  "chrome-automation",
]);

const HYBRID_CATEGORIES = new Set<CloudCompatibilityCategory>([
  "bash-run",
  "job-create",
  "job-trigger",
  "absolute-path",
]);

interface PatternRule {
  category: CloudCompatibilityCategory;
  severity: CloudCompatibilityFinding["severity"];
  pattern: RegExp;
  message: string;
  remediation: string;
}

const APP_PATTERNS: PatternRule[] = [
  {
    category: "papr-api",
    severity: "error",
    pattern: /\bwindow\.paprAPI\b|\bpaprAPI\.invoke\s*\(/,
    message: "Uses window.paprAPI — desktop Electron only, not available on apps.papr.ai.",
    remediation:
      "Use /api/db/* for data, /api/jobs/run for background work, or mark the feature as desktop-only in the UI.",
  },
  {
    category: "localhost-gateway",
    severity: "error",
    pattern:
      /(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1):18789\b|['"`]ws:\/\/localhost:18789['"`]/,
    message: "Hardcoded Paprwork gateway URL — breaks on apps.papr.ai.",
    remediation:
      "Use same-origin paths (/api/jobs/run, /api/db/query) or relative WebSocket URLs.",
  },
  {
    category: "bash-run",
    severity: "warning",
    pattern: /fetch\s*\(\s*['"`]\/api\/bash\/run|['"`]\/api\/bash\/run['"`]/,
    message: "/api/bash/run is disabled on cloud app host.",
    remediation:
      "Use POST /api/app/backend/:action, POST /api/jobs/run, or /api/db/* instead.",
  },
  {
    category: "job-create",
    severity: "warning",
    pattern: /fetch\s*\(\s*['"`]\/api\/jobs\/create|['"`]\/api\/jobs\/create['"`]/,
    message: "Creates jobs from the mini-app — limited on cloud and needs Paprwork desktop for some job types.",
    remediation:
      "Pre-create jobs on desktop or use backend handlers for dynamic workflows.",
  },
  {
    category: "job-trigger",
    severity: "warning",
    pattern: /fetch\s*\(\s*['"`]\/api\/jobs\/run|['"`]\/api\/jobs\/run['"`]/,
    message: "Triggers background jobs from the web UI.",
    remediation:
      "Cloud can run compatible jobs; Chrome/automation jobs still need Paprwork desktop open.",
  },
  {
    category: "chrome-automation",
    severity: "error",
    pattern:
      /(?:puppeteer\.connect|connectOverCDP|:9222\b|chrome-manager|linkedin-chrome-shared)/i,
    message: "Uses local Chrome / CDP automation — requires Paprwork desktop.",
    remediation:
      "Run automation on desktop only, or redesign with cloud-safe APIs and ephemeral Playwright in agent jobs.",
  },
  {
    category: "absolute-path",
    severity: "warning",
    pattern: /(?:\/Users\/[^"'\s]+|~\/Papr\/|~\/papr-)/i,
    message: "Contains machine-specific absolute paths.",
    remediation:
      "Use linked data-sources.json with job IDs (Turso sync) instead of hardcoded dbPath values.",
  },
  {
    category: "cloud-db",
    severity: "info",
    pattern: /fetch\s*\(\s*['"`]\/api\/db\/(query|write|exec|batch)|['"`]\/api\/db\/(query|write)/,
    message: "Uses cloud-compatible /api/db/* endpoints.",
    remediation: "",
  },
];

const JOB_PATTERNS: PatternRule[] = [
  {
    category: "chrome-automation",
    severity: "error",
    pattern:
      /(?:puppeteer\.connect|connectOverCDP|browserURL.*9222|:9222\b|chrome-manager|linkedin-chrome-shared|Launching Chrome)/i,
    message: "Job uses persistent local Chrome / CDP — cannot run on apps.papr.ai.",
    remediation:
      "Schedule this job on desktop Paprwork only, or migrate to API-first / vault-cookie Playwright in cloud agent runs.",
  },
  {
    category: "localhost-gateway",
    severity: "error",
    pattern: /(?:localhost|127\.0\.0\.1):18789/,
    message: "Job calls the local Paprwork gateway — not available in cloud app iframe.",
    remediation: "Use $APP_DB / $JOB_DB writes or Turso-synced SQLite instead of localhost API calls.",
  },
];

function stripLineComment(line: string, ext: string): string {
  const trimmed = line.trim();
  if (ext === ".json") return line;
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  ) {
    return "";
  }
  const slash = line.indexOf("//");
  if (slash >= 0) {
    const before = line.slice(0, slash);
    if (!before.endsWith(":")) {
      return before;
    }
  }
  return line;
}

function scanContentWithPatterns(
  content: string,
  file: string,
  patterns: PatternRule[],
): CloudCompatibilityFinding[] {
  const findings: CloudCompatibilityFinding[] = [];
  const ext = file.includes(".") ? file.slice(file.lastIndexOf(".")).toLowerCase() : "";
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const checkLine = stripLineComment(lines[index], ext);
    if (!checkLine.trim()) continue;

    for (const rule of patterns) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(checkLine)) continue;

      findings.push({
        category: rule.category,
        severity: rule.severity,
        file,
        line: index + 1,
        message: rule.message,
        remediation: rule.remediation,
      });
      break;
    }
  }

  return findings;
}

export function scanMiniAppCloudCompatibility(
  fileContents: Map<string, string>,
  dataSourcesRaw?: string,
): CloudCompatibilityFinding[] {
  const findings: CloudCompatibilityFinding[] = [];

  for (const [filename, content] of fileContents.entries()) {
    if (!SOURCE_FILE.test(filename)) continue;
    findings.push(...scanContentWithPatterns(content, filename, APP_PATTERNS));
  }

  if (dataSourcesRaw) {
    findings.push(
      ...scanContentWithPatterns(dataSourcesRaw, "data-sources.json", [
        {
          category: "absolute-path",
          severity: "warning",
          pattern: /"dbPath"\s*:\s*"[^"]*(?:\/Users\/|~\/)/,
          message: "data-sources.json uses a local absolute dbPath.",
          remediation:
            "Cloud apps read Turso via linked job IDs — republish after Cloud Sync links databases.",
        },
      ]),
    );
  }

  return dedupeFindings(findings);
}

export function scanJobCloudCompatibility(
  jobId: string,
  jobName: string,
  command: string,
  extraFiles: Map<string, string>,
): CloudCompatibilityFinding[] {
  const findings: CloudCompatibilityFinding[] = [];
  const prefix = `job:${jobId}`;

  findings.push(
    ...scanContentWithPatterns(command, `${prefix} (${jobName}) command`, JOB_PATTERNS),
  );

  for (const [relPath, content] of extraFiles.entries()) {
    if (!/\.(js|ts|py|sh|mjs|cjs)$/i.test(relPath)) continue;
    findings.push(
      ...scanContentWithPatterns(content, `${prefix}/${relPath}`, JOB_PATTERNS),
    );
  }

  return dedupeFindings(findings);
}

function dedupeFindings(
  findings: CloudCompatibilityFinding[],
): CloudCompatibilityFinding[] {
  const seen = new Set<string>();
  const out: CloudCompatibilityFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.category}|${finding.file}|${finding.line ?? 0}|${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

export function buildCloudCompatibilityReport(
  findings: CloudCompatibilityFinding[],
): CloudCompatibilityReport {
  const hasDesktopOnly = findings.some((f) =>
    DESKTOP_ONLY_CATEGORIES.has(f.category),
  );
  const hasHybrid = findings.some((f) => HYBRID_CATEGORIES.has(f.category));

  const cloudDb = findings.some((f) => f.category === "cloud-db");

  let level: CloudCompatibilityLevel = "cloud-ready";
  if (hasDesktopOnly) {
    level = "desktop-only";
  } else if (hasHybrid) {
    level = "hybrid";
  }

  const cloudWorks: string[] = [];
  const desktopOnly: string[] = [];

  if (cloudDb) {
    cloudWorks.push("Dashboard and read-only data via /api/db/* on apps.papr.ai");
  }
  if (level === "cloud-ready") {
    cloudWorks.push("Core UI should work on apps.papr.ai without Paprwork desktop");
  }
  if (level === "hybrid") {
    cloudWorks.push("Viewing linked database data on apps.papr.ai (when Turso is synced)");
    desktopOnly.push("Job triggers, bash, or job creation from the web UI");
  }
  if (level === "desktop-only") {
    if (findings.some((f) => f.category === "papr-api")) {
      desktopOnly.push("Electron paprAPI features (chat.open, shell, notifications)");
    }
    if (findings.some((f) => f.category === "localhost-gateway")) {
      desktopOnly.push("Features calling localhost:18789 instead of same-origin APIs");
    }
    if (findings.some((f) => f.category === "chrome-automation")) {
      desktopOnly.push("LinkedIn / Chrome Manager / CDP browser automation");
    }
    if (cloudDb) {
      cloudWorks.push("Read-only dashboard data may still load on apps.papr.ai");
    }
  }

  const summary =
    level === "cloud-ready"
      ? "This app looks cloud-ready — it should work on apps.papr.ai."
      : level === "hybrid"
        ? "Hybrid app — dashboard works on the web; automation needs Paprwork desktop."
        : "Desktop-only app — publishing is allowed, but key features will not work on apps.papr.ai.";

  return {
    level,
    summary,
    publishAllowed: true,
    requiresAcknowledgement: level === "desktop-only",
    cloudWorks,
    desktopOnly,
    findings,
  };
}

export function mergeCloudCompatibilityFindings(
  groups: CloudCompatibilityFinding[][],
): CloudCompatibilityReport {
  return buildCloudCompatibilityReport(dedupeFindings(groups.flat()));
}
