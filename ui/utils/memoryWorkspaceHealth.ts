const TEMPLATE_MARKERS = [
  "(Name, role, industry, organization)",
  "(Tone preferences",
  "(What the user is actively",
  "(What the user wants",
  "(Industry-specific",
  "(Important decisions",
  "(User preferences",
  "(Recurring patterns",
  "(Mistakes to avoid",
  "(not set)",
] as const;

/** True when a workspace markdown file still has template placeholder content. */
export function isWorkspaceFilePlaceholder(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return true;
  }

  if (TEMPLATE_MARKERS.some((marker) => trimmed.includes(marker))) {
    return true;
  }

  const bodyLines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("#") &&
        !line.startsWith("---") &&
        !line.startsWith("**Note"),
    );

  if (bodyLines.length === 0) {
    return true;
  }

  const placeholderLines = bodyLines.filter((line) => /^\([^)]+\)\.?$/.test(line)).length;
  return placeholderLines / bodyLines.length >= 0.5;
}

export function countPlaceholderContextFiles(
  files: ReadonlyArray<{ name: string; content: string }>,
): number {
  return files.filter((file) => isWorkspaceFilePlaceholder(file.content)).length;
}
