/** Max chars for post-edit snippet in tool results (cache-friendly vs full re-read). */
export const POST_EDIT_SNIPPET_MAX_CHARS = 2000;

const DEFAULT_LINE_WINDOW = 24;

export interface PostEditSnippetResult {
  postEditSnippet: string;
  totalLines: number;
  snippetTruncated: boolean;
}

/**
 * Build a bounded excerpt of file content after an edit.
 * Keeps the changed region visible without a follow-up read_app_file call.
 */
export function buildPostEditSnippet(
  content: string,
  options?: {
    /** 1-indexed line to center the window on (line-range edits). */
    focusLine?: number;
    /** Substring to locate the edit region (string-replace edits). */
    focusText?: string;
  },
): PostEditSnippetResult {
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (content.length <= POST_EDIT_SNIPPET_MAX_CHARS) {
    return {
      postEditSnippet: content,
      totalLines,
      snippetTruncated: false,
    };
  }

  let startLine = 0;
  let endLine = totalLines;

  if (options?.focusLine !== undefined && options.focusLine >= 1) {
    const center = options.focusLine - 1;
    startLine = Math.max(0, center - DEFAULT_LINE_WINDOW);
    endLine = Math.min(totalLines, center + DEFAULT_LINE_WINDOW + 1);
  } else if (options?.focusText && options.focusText.length > 0) {
    const needle = options.focusText.slice(0, 200);
    const index = content.indexOf(needle);
    if (index >= 0) {
      const startChar = Math.max(0, index - 600);
      const endChar = Math.min(
        content.length,
        index + needle.length + POST_EDIT_SNIPPET_MAX_CHARS - 700,
      );
      let snippet = content.slice(startChar, endChar);
      if (startChar > 0) {
        snippet = `[...]\n${snippet}`;
      }
      if (endChar < content.length) {
        snippet = `${snippet}\n[...]`;
      }
      return {
        postEditSnippet: snippet.slice(0, POST_EDIT_SNIPPET_MAX_CHARS),
        totalLines,
        snippetTruncated: true,
      };
    }
  }

  let snippet = lines.slice(startLine, endLine).join("\n");
  if (startLine > 0 || endLine < totalLines) {
    snippet = `Lines ${startLine + 1}-${endLine} of ${totalLines}:\n${snippet}`;
  }
  if (snippet.length > POST_EDIT_SNIPPET_MAX_CHARS) {
    snippet =
      snippet.slice(0, POST_EDIT_SNIPPET_MAX_CHARS) +
      `\n[... snippet truncated; ${totalLines} lines total]`;
    return {
      postEditSnippet: snippet,
      totalLines,
      snippetTruncated: true,
    };
  }

  return {
    postEditSnippet: snippet,
    totalLines,
    snippetTruncated: startLine > 0 || endLine < totalLines,
  };
}
