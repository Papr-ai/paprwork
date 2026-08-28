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
] as const;

/** First-run blockers — MEMORY.md is curated by the sleep cycle, not onboarding. */
const CORE_SETUP_FILES = new Set([
  "IDENTITY.md",
  "AGENTS.md",
  "TOOLS.md",
]);

const IDENTITY_ABOUT_PLACEHOLDER = "(Name, role, industry, organization)";

function extractIdentityAboutBody(content: string): string | null {
  const match = content.match(/## About\n\n([\s\S]*?)(?=\n## |\n---|\Z)/);
  return match?.[1]?.trim() ?? null;
}

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

/** BRAND.md uses "(not set)" for optional fields — not a first-run blocker. */
export function isBrandFileUnset(content: string): boolean {
  return content.includes("(not set)");
}

export function isOptionalContextFile(fileName: string): boolean {
  return fileName === "BRAND.md";
}

/** IDENTITY.md About section has real user profile content (not template). */
export function isIdentitySetupComplete(content: string | undefined): boolean {
  if (!content?.trim()) {
    return false;
  }
  const aboutBody = extractIdentityAboutBody(content);
  if (!aboutBody || aboutBody.includes(IDENTITY_ABOUT_PLACEHOLDER)) {
    return false;
  }
  return /\*\*Name:\*\*\s+\S/.test(aboutBody);
}

/** Whether a context file card should show the "Setup needed" chip. */
export function isContextFileSetupNeeded(
  fileName: string,
  content: string,
): boolean {
  if (isOptionalContextFile(fileName)) {
    return false;
  }
  if (fileName === "IDENTITY.md") {
    return !isIdentitySetupComplete(content);
  }
  // MEMORY.md is distilled nightly from daily logs — not a first-run blocker.
  if (fileName === "MEMORY.md") {
    return false;
  }
  return isWorkspaceFilePlaceholder(content);
}

export function countSetupBlockingPlaceholderFiles(
  files: ReadonlyArray<{ name: string; content: string }>,
): number {
  return files.filter(
    (file) =>
      CORE_SETUP_FILES.has(file.name) &&
      isWorkspaceFilePlaceholder(file.content),
  ).length;
}

/** @deprecated Use countSetupBlockingPlaceholderFiles */
export function countPlaceholderContextFiles(
  files: ReadonlyArray<{ name: string; content: string }>,
): number {
  return countSetupBlockingPlaceholderFiles(files);
}

export function shouldShowMemorySetupPanel(options: {
  onboardingPending: boolean;
  contextFiles: ReadonlyArray<{ name: string; content: string }>;
  wikiHasContent: boolean;
}): boolean {
  const identityFile = options.contextFiles.find((file) => file.name === "IDENTITY.md");
  const identityComplete = isIdentitySetupComplete(identityFile?.content);
  const corePlaceholders = countSetupBlockingPlaceholderFiles(options.contextFiles);

  if (identityComplete && options.wikiHasContent) {
    return false;
  }

  if (identityComplete) {
    // ONBOARD.md may be stale if sleep cycle filled IDENTITY but never renamed the file.
    return corePlaceholders > 0;
  }

  return options.onboardingPending || corePlaceholders > 0;
}

export function isEffectiveOnboardingPending(
  onboardingPending: boolean,
  contextFiles: ReadonlyArray<{ name: string; content: string }>,
): boolean {
  if (!onboardingPending) {
    return false;
  }
  const identityFile = contextFiles.find((file) => file.name === "IDENTITY.md");
  return !isIdentitySetupComplete(identityFile?.content);
}
