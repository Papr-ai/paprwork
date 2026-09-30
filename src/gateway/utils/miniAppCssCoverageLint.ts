/**
 * CSS coverage + shrink checks for validate_app.
 *
 * Catches markup that references classes with no matching CSS rule (unstyled UI)
 * and sudden drops in total selector count (accidental bulk deletion).
 */

import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { ValidationIssue } from "../services/AppService.js";

const MIN_CLASS_NAME_LENGTH = 3;
const MAX_CLASS_COVERAGE_ISSUES = 8;
const SHRINK_RATIO_THRESHOLD = 0.7;

const MARKUP_FILE = /\.(html|tsx)$/i;
const CLASS_ATTR_RE = /class(?:Name)?=["']([^"']+)["']/g;
const CSS_CLASS_RE = /\.([a-zA-Z_][\w-]*)/g;

let liquidGlassBaseCss: string | null = null;
let liquidGlassBaseClasses: Set<string> | null = null;

/** appId → total CSS selector token count from last validate_app run */
const selectorCountBaseline = new Map<string, number>();

function resolveLiquidGlassBasePath(): string | null {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(thisDir, "../../resources/app-templates/liquid-glass-base.css"),
    path.resolve(thisDir, "../../../src/resources/app-templates/liquid-glass-base.css"),
    path.resolve(process.cwd(), "src/resources/app-templates/liquid-glass-base.css"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function loadLiquidGlassBaseCss(): string {
  if (liquidGlassBaseCss !== null) {
    return liquidGlassBaseCss;
  }
  const basePath = resolveLiquidGlassBasePath();
  if (basePath) {
    liquidGlassBaseCss = readFileSync(basePath, "utf8");
    return liquidGlassBaseCss;
  }
  liquidGlassBaseCss = "";
  return liquidGlassBaseCss;
}

function getLiquidGlassBaseClasses(): Set<string> {
  if (liquidGlassBaseClasses !== null) {
    return liquidGlassBaseClasses;
  }
  liquidGlassBaseClasses = extractCssClassNames(loadLiquidGlassBaseCss());
  return liquidGlassBaseClasses;
}

/** Unique class names defined in CSS (e.g. .stat-row → stat-row). */
export function extractCssClassNames(css: string): Set<string> {
  const classes = new Set<string>();
  for (const match of css.matchAll(CSS_CLASS_RE)) {
    classes.add(match[1]);
  }
  return classes;
}

/** Total .class tokens — sensitive to bulk rule deletion for shrink detection. */
export function countCssSelectorTokens(css: string): number {
  return [...css.matchAll(CSS_CLASS_RE)].length;
}

function collectDefinedClasses(fileContents: Map<string, string>): Set<string> {
  const defined = new Set(getLiquidGlassBaseClasses());
  for (const [filename, content] of fileContents) {
    if (!filename.endsWith(".css")) {
      continue;
    }
    for (const className of extractCssClassNames(content)) {
      defined.add(className);
    }
  }
  return defined;
}

function collectTotalSelectorTokens(fileContents: Map<string, string>): number {
  let total = 0;
  for (const [filename, content] of fileContents) {
    if (!filename.endsWith(".css")) {
      continue;
    }
    total += countCssSelectorTokens(content);
  }
  return total;
}

interface StaticClassUse {
  cls: string;
  file: string;
  line: number;
}

function collectStaticClassUses(fileContents: Map<string, string>): StaticClassUse[] {
  const uses: StaticClassUse[] = [];

  for (const [filename, content] of fileContents) {
    if (!MARKUP_FILE.test(filename)) {
      continue;
    }

    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      for (const match of line.matchAll(CLASS_ATTR_RE)) {
        const classAttr = match[1];
        if (classAttr.includes("${")) {
          continue;
        }
        for (const token of classAttr.split(/\s+/)) {
          const cls = token.trim();
          if (cls.length < MIN_CLASS_NAME_LENGTH) {
            continue;
          }
          uses.push({ cls, file: filename, line: index + 1 });
        }
      }
    }
  }

  return uses;
}

export function checkMiniAppCssClassCoverage(
  fileContents: Map<string, string>,
): ValidationIssue[] {
  const defined = collectDefinedClasses(fileContents);
  const issues: ValidationIssue[] = [];
  const reported = new Set<string>();

  for (const use of collectStaticClassUses(fileContents)) {
    if (defined.has(use.cls) || reported.has(use.cls)) {
      continue;
    }
    reported.add(use.cls);
    issues.push({
      file: use.file,
      line: use.line,
      severity: "warning",
      rule: "css-class-coverage",
      message:
        `Class "${use.cls}" is used in markup but has no .${use.cls} rule in app CSS or Liquid Glass base.css — may render unstyled`,
    });
    if (issues.length >= MAX_CLASS_COVERAGE_ISSUES) {
      break;
    }
  }

  return issues;
}

export function checkMiniAppCssShrink(
  appId: string,
  fileContents: Map<string, string>,
): ValidationIssue[] {
  const currentCount = collectTotalSelectorTokens(fileContents);
  const previousCount = selectorCountBaseline.get(appId);

  selectorCountBaseline.set(appId, currentCount);

  if (previousCount === undefined || previousCount === 0) {
    return [];
  }

  if (currentCount >= previousCount * SHRINK_RATIO_THRESHOLD) {
    return [];
  }

  const dropPct = Math.round((1 - currentCount / previousCount) * 100);
  return [
    {
      file: "app",
      severity: "warning",
      rule: "css-shrink",
      message:
        `CSS selector count dropped ${previousCount} → ${currentCount} (−${dropPct}%) across app stylesheets — possible accidental deletion (e.g. overwrite during file split). Re-read CSS files and validate_app again.`,
    },
  ];
}

export function checkMiniAppCssCoverageAndShrink(
  appId: string,
  fileContents: Map<string, string>,
): ValidationIssue[] {
  return [
    ...checkMiniAppCssClassCoverage(fileContents),
    ...checkMiniAppCssShrink(appId, fileContents),
  ];
}

/** Test helper — reset per-app shrink baselines. */
export function resetCssSelectorBaselineForTests(appId?: string): void {
  if (appId === undefined) {
    selectorCountBaseline.clear();
    return;
  }
  selectorCountBaseline.delete(appId);
}

/** Test helper — reset cached Liquid Glass base.css reads. */
export function resetLiquidGlassBaseCacheForTests(): void {
  liquidGlassBaseCss = null;
  liquidGlassBaseClasses = null;
}
