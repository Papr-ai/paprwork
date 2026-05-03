/**
 * FileWritePreview Component
 *
 * Renders an inline, collapsible preview of file content for tools that
 * write or modify files. Detects the file/path/content from the tool's
 * args (and result, for git diffs from bash).
 *
 * Supported tools:
 *   - write_file              → full content preview
 *   - create_document         → markdown preview
 *   - import_document         → metadata only (content not in args)
 *   - create_app              → list of files with content
 *   - create_job              → command + files
 *   - edit_app_file           → diff (oldStr → newStr)
 *   - edit_job_file           → diff
 *   - edit_app_file_lines     → range + new content
 *   - bash (Tier 4)           → git diff stats from result.gitChanges
 */

import React, { useState } from "react";

interface FileWritePreviewProps {
  toolName: string;
  args?: Record<string, unknown>;
  result?: string;
}

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    md: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    sh: "bash",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "scss",
  };
  return map[ext] ?? "text";
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function lineCount(s: string): number {
  if (!s) return 0;
  return s.split("\n").length;
}

const PreviewHeader: React.FC<{
  label: string;
  meta?: string;
  expanded: boolean;
  onToggle: () => void;
}> = ({ label, meta, expanded, onToggle }) => (
  <div
    className="file-preview-header"
    onMouseDown={(e) => { e.preventDefault(); onToggle(); }}
  >
    <span className={`file-preview-chevron ${expanded ? "" : "collapsed"}`}>▼</span>
    <span className="file-preview-label">{label}</span>
    {meta && <span className="file-preview-meta">{meta}</span>}
  </div>
);

const CodeBlock: React.FC<{
  code: string;
  language?: string;
  maxHeight?: number;
}> = ({ code, language, maxHeight = 480 }) => (
  <pre
    className={`file-preview-code language-${language ?? "text"}`}
    style={{ maxHeight, overflow: "auto" }}
  >
    <code>{code}</code>
  </pre>
);

const DiffBlock: React.FC<{
  oldStr: string;
  newStr: string;
  maxHeight?: number;
}> = ({ oldStr, newStr, maxHeight = 480 }) => {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  return (
    <pre className="file-preview-diff" style={{ maxHeight, overflow: "auto" }}>
      <code>
        {oldLines.map((l, i) => (
          <div key={`o${i}`} className="diff-removed">- {l}</div>
        ))}
        {newLines.map((l, i) => (
          <div key={`n${i}`} className="diff-added">+ {l}</div>
        ))}
      </code>
    </pre>
  );
};

export const FileWritePreview: React.FC<FileWritePreviewProps> = ({
  toolName,
  args,
  result,
}) => {
  const [expanded, setExpanded] = useState(false);
  if (!args && !result) return null;

  const path = (args?.path ?? args?.filePath ?? args?.file ?? "") as string;
  const content = asString(args?.content);
  const oldStr = asString(args?.oldStr ?? args?.old);
  const newStr = asString(args?.newStr ?? args?.new ?? args?.newContent);
  const startLine = args?.startLine as number | undefined;
  const endLine = args?.endLine as number | undefined;

  if (
    toolName === "write_file" ||
    toolName === "create_document" ||
    toolName === "restore_app_file_version" ||
    toolName === "restore_job_file_version"
  ) {
    if (!content && !path) return null;
    const lines = lineCount(content);
    const lang = detectLanguage(path);
    return (
      <div className="file-preview">
        <PreviewHeader
          label={path || "(file)"}
          meta={lines > 0 ? `${lines} lines` : undefined}
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
        />
        {expanded && content && <CodeBlock code={content} language={lang} />}
      </div>
    );
  }

  if (toolName === "edit_app_file" || toolName === "edit_job_file") {
    if (!oldStr && !newStr) return null;
    const filename = (args?.filename ?? args?.path ?? "") as string;
    return (
      <div className="file-preview">
        <PreviewHeader
          label={filename || "(file)"}
          meta={`-${lineCount(oldStr)} +${lineCount(newStr)}`}
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
        />
        {expanded && <DiffBlock oldStr={oldStr} newStr={newStr} />}
      </div>
    );
  }

  if (toolName === "edit_app_file_lines" || toolName === "edit_job_file_lines") {
    const filename = (args?.filename ?? args?.path ?? "") as string;
    if (!newStr && !content) return null;
    const code = newStr || content;
    const lang = detectLanguage(filename);
    const range = startLine && endLine ? `lines ${startLine}-${endLine}` : "";
    return (
      <div className="file-preview">
        <PreviewHeader
          label={filename || "(file)"}
          meta={range || `${lineCount(code)} lines`}
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
        />
        {expanded && <CodeBlock code={code} language={lang} />}
      </div>
    );
  }

  if (toolName === "create_app" || toolName === "create_job") {
    const files = args?.files as
      | Array<{ filename?: string; content?: string }>
      | undefined;
    const command = args?.command as string | undefined;
    if ((!files || files.length === 0) && !command) return null;
    return (
      <div className="file-preview">
        <PreviewHeader
          label={
            (args?.title as string) ||
            (args?.name as string) ||
            (toolName === "create_job" ? "(job)" : "(app)")
          }
          meta={
            files
              ? `${files.length} file${files.length === 1 ? "" : "s"}`
              : undefined
          }
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
        />
        {expanded && (
          <>
            {command && (
              <CodeBlock code={`$ ${command}`} language="bash" maxHeight={120} />
            )}
            {files?.map((f, i) => (
              <div key={i} className="file-preview-subfile">
                <div className="file-preview-subfile-name">{f.filename}</div>
                <CodeBlock
                  code={f.content ?? ""}
                  language={detectLanguage(f.filename ?? "")}
                />
              </div>
            ))}
          </>
        )}
      </div>
    );
  }

  if (toolName === "bash" && result) {
    const match = result.match(/__GIT_CHANGES__:(.+?):__END__/s);
    if (!match) return null;
    let gitChanges: { stat?: string; files?: string[] } | null = null;
    try {
      gitChanges = JSON.parse(match[1]);
    } catch { return null; }
    if (!gitChanges?.stat) return null;
    return (
      <div className="file-preview">
        <PreviewHeader
          label="Files changed"
          meta={
            gitChanges.files
              ? `${gitChanges.files.length} file${gitChanges.files.length === 1 ? "" : "s"}`
              : undefined
          }
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
        />
        {expanded && <CodeBlock code={gitChanges.stat} language="text" maxHeight={240} />}
      </div>
    );
  }

  return null;
};

export function hasFilePreview(
  toolName: string,
  args?: Record<string, unknown>,
  result?: string,
): boolean {
  switch (toolName) {
    case "write_file":
    case "create_document":
    case "restore_app_file_version":
    case "restore_job_file_version":
      return Boolean(args?.content || args?.path);
    case "edit_app_file":
    case "edit_job_file":
      return Boolean(args?.oldStr || args?.newStr);
    case "edit_app_file_lines":
    case "edit_job_file_lines":
      return Boolean(args?.newContent || args?.content || args?.newStr);
    case "create_app":
      return Boolean(
        (args?.files as unknown[] | undefined)?.length || args?.title,
      );
    case "create_job":
      return Boolean(args?.command || args?.title);
    case "bash":
      return typeof result === "string" && result.includes("__GIT_CHANGES__:");
    default:
      return false;
  }
}
