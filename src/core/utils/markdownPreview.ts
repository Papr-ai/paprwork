/**
 * Convert markdown document content into plain-text preview snippets.
 */

const HEADING_RE = /^#{1,6}\s+/;
const HORIZONTAL_RULE_RE = /^(-{3,}|\*{3,}|_{3,})$/;

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(HEADING_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

function previewSourceText(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const withoutCodeBlocks = normalized.replace(/```[\s\S]*?```/g, " ");
  const lines = withoutCodeBlocks.split("\n");

  const bodyLines: string[] = [];
  let skippedLeadingHeading = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (HORIZONTAL_RULE_RE.test(trimmed)) continue;

    if (!skippedLeadingHeading && HEADING_RE.test(trimmed)) {
      skippedLeadingHeading = true;
      continue;
    }

    bodyLines.push(
      trimmed
        .replace(/^\s*[-*+]\s+/, "")
        .replace(/^\s*\d+\.\s+/, ""),
    );
    if (bodyLines.join(" ").length >= 400) break;
  }

  if (bodyLines.length === 0) {
    const firstHeading = normalized.match(/^#{1,6}\s+(.+)$/m)?.[1];
    return firstHeading ?? normalized;
  }

  return bodyLines.join(" ");
}

function truncatePreview(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength).trimEnd();
  const lastSpace = clipped.lastIndexOf(" ");
  const safe =
    lastSpace > Math.floor(maxLength * 0.6)
      ? clipped.slice(0, lastSpace)
      : clipped;
  return `${safe}…`;
}

/** Plain-text preview for document cards and metadata. */
export function markdownPreviewText(content: string, maxLength = 200): string {
  if (!content.trim()) return "";

  const source = previewSourceText(content);
  const plain = stripInlineMarkdown(source);
  if (!plain) return "";

  return truncatePreview(plain, maxLength);
}
