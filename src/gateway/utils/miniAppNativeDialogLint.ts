/**
 * Lint mini-apps for window.prompt/confirm/alert — silently broken in Paprwork
 * iframes (local preview, published preview toggle, and most cloud embeds).
 */

import type { ValidationIssue } from "../services/AppService.js";

const SOURCE_FILE = /\.(html|tsx?|jsx?)$/i;

const NATIVE_DIALOG_PATTERN =
  /\b(?:window\.)?(?:prompt|confirm|alert)\s*\(/g;

function stripCommentsForLint(line: string, ext: string): string {
  const trimmed = line.trim();

  if (ext === ".html" || ext === ".htm") {
    if (trimmed.startsWith("<!--")) {
      return "";
    }
    const htmlComment = line.indexOf("<!--");
    if (htmlComment >= 0) {
      return line.slice(0, htmlComment);
    }
  }

  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  ) {
    return "";
  }

  const slashComment = line.indexOf("//");
  if (slashComment >= 0) {
    return line.slice(0, slashComment);
  }

  return line;
}

function findNativeDialogCalls(line: string): string[] {
  const matches: string[] = [];
  for (const match of line.matchAll(NATIVE_DIALOG_PATTERN)) {
    const token = match[0].replace(/\s*\($/, "");
    matches.push(token.replace(/^window\./, ""));
  }
  return matches;
}

export function checkMiniAppNativeDialogPatterns(
  fileContents: Map<string, string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [filename, content] of fileContents) {
    if (!SOURCE_FILE.test(filename)) {
      continue;
    }

    const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    const lines = content.split("\n");

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      const checkLine = stripCommentsForLint(line, ext);
      const calls = findNativeDialogCalls(checkLine);
      if (calls.length === 0) {
        continue;
      }

      const unique = [...new Set(calls)];
      issues.push({
        file: filename,
        line: index + 1,
        severity: "error",
        rule: "no-native-dialogs",
        message:
          `Do not use window.${unique.join("/")}() in mini-apps — it silently fails in Paprwork iframes ` +
          "(returns null/false with no dialog). Use " +
          "`import { papr } from '/__papr__/papr-sdk.ts'` (or `askText`/`askConfirm` from papr-dialog) instead.",
      });
    }
  }

  return issues;
}
