/**
 * Utilities for exact-string file editing (edit_app_file / edit_job_file).
 */

export function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

export function getOccurrenceLineNumbers(
  content: string,
  needle: string,
  maxLines = 5,
): number[] {
  const lines: number[] = [];
  if (needle.length === 0) return lines;

  let pos = 0;
  while ((pos = content.indexOf(needle, pos)) !== -1) {
    const line = content.slice(0, pos).split("\n").length;
    lines.push(line);
    if (lines.length >= maxLines) break;
    pos += needle.length;
  }
  return lines;
}

export function replaceOccurrence(
  content: string,
  oldString: string,
  newString: string,
  occurrence: number,
): string {
  if (occurrence < 1) {
    throw new Error(`occurrence must be >= 1, got ${occurrence}`);
  }

  let pos = 0;
  let found = 0;
  while ((pos = content.indexOf(oldString, pos)) !== -1) {
    found++;
    if (found === occurrence) {
      return (
        content.slice(0, pos) +
        newString +
        content.slice(pos + oldString.length)
      );
    }
    pos += oldString.length;
  }

  throw new Error(
    `occurrence ${occurrence} not found (only ${found} match${found === 1 ? "" : "es"} in file)`,
  );
}

export function verifyStringReplacement(args: {
  before: string;
  after: string;
  oldString: string;
  newString: string;
  occurrence: number;
}): void {
  const beforeCount = countOccurrences(args.before, args.oldString);
  const afterCount = countOccurrences(args.after, args.oldString);

  if (beforeCount === 0) {
    throw new Error("oldString not found in file");
  }
  if (args.occurrence > beforeCount) {
    throw new Error(
      `occurrence ${args.occurrence} requested but only ${beforeCount} matches found`,
    );
  }
  // newString may legitimately contain oldString (e.g. replacing "def main():" with an expanded main())
  const embeddedInReplacement = countOccurrences(args.newString, args.oldString);
  const expectedAfterCount = beforeCount - 1 + embeddedInReplacement;
  if (afterCount !== expectedAfterCount) {
    throw new Error(
      `Edit verification failed: oldString still appears ${afterCount} times (expected ${expectedAfterCount})`,
    );
  }
  if (args.newString.length > 0 && !args.after.includes(args.newString)) {
    throw new Error(
      "Edit verification failed: newString not found in file after replace",
    );
  }
}

export interface ExactStringReplaceResult {
  newContent: string;
  occurrencesFound: number;
  occurrenceReplaced: number;
}

export function applyExactStringReplacement(args: {
  content: string;
  filename: string;
  oldString: string;
  newString: string;
  occurrence?: number;
  linesToolName?: string;
}): ExactStringReplaceResult {
  const occurrences = countOccurrences(args.content, args.oldString);
  if (occurrences === 0) {
    throw new Error(
      `String not found in ${args.filename}. Make sure oldString matches exactly. ` +
        `Read the file first to get current content.`,
    );
  }

  if (occurrences > 1 && args.occurrence === undefined) {
    const lines = getOccurrenceLineNumbers(args.content, args.oldString);
    const lineHint =
      lines.length > 0 ? ` Matches at lines: ${lines.join(", ")}.` : "";
    const altTool = args.linesToolName ?? "edit_*_file_lines";
    throw new Error(
      `oldString appears ${occurrences} times in ${args.filename}. ` +
        `Use ${altTool}, add more surrounding context to oldString, or pass occurrence (1-${occurrences}).${lineHint}`,
    );
  }

  const occurrence = args.occurrence ?? 1;
  const newContent = replaceOccurrence(
    args.content,
    args.oldString,
    args.newString,
    occurrence,
  );

  verifyStringReplacement({
    before: args.content,
    after: newContent,
    oldString: args.oldString,
    newString: args.newString,
    occurrence,
  });

  return {
    newContent,
    occurrencesFound: occurrences,
    occurrenceReplaced: occurrence,
  };
}
