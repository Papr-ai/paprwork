/**
 * Lint mini-apps for emoji characters in UI source (labels, buttons, headings, etc.).
 * Enforced as errors via validate_app so agents must remove emojis before continuing.
 */

import type { ValidationIssue } from "../services/AppService.js";

const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

const SOURCE_FILE = /\.(html|css|tsx?|jsx?)$/i;

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

function extractEmojiSnippet(line: string): string {
  const match = EMOJI_PATTERN.exec(line);
  if (!match || match.index === undefined) {
    return "emoji";
  }
  const start = Math.max(0, match.index - 8);
  const end = Math.min(line.length, match.index + 12);
  const snippet = line.slice(start, end).trim();
  return snippet.length > 0 ? `"${snippet}"` : "emoji";
}

export function checkMiniAppEmojiPatterns(
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
      const line = lines[index];
      const checkLine = stripCommentsForLint(line, ext);
      if (!EMOJI_PATTERN.test(checkLine)) {
        continue;
      }

      issues.push({
        file: filename,
        line: index + 1,
        severity: "error",
        rule: "no-emojis",
        message:
          `Emoji characters are not allowed in mini-app UI (${extractEmojiSnippet(checkLine)}). ` +
          "Use SVG icons, text labels, or CSS — never emoji in headings, buttons, labels, or body copy. " +
          "For tab icons, pass an inline SVG or PNG data URI to create_app({ icon: ... }).",
      });
    }
  }

  return issues;
}
