/**
 * WorkspaceCodeEditor — syntax-highlighted editable code pane.
 */

import React, { useCallback, useEffect, useRef } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import "./WorkspaceCodeEditor.css";

interface WorkspaceCodeEditorProps {
  value: string;
  language: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
}

function useSyntaxTheme(): typeof oneDark {
  const [theme, setTheme] = React.useState<typeof oneDark>(oneDark);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => setTheme(media.matches ? oneLight : oneDark);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  return theme;
}

export function WorkspaceCodeEditor({
  value,
  language,
  readOnly = false,
  onChange,
}: WorkspaceCodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const theme = useSyntaxTheme();

  const syncScroll = useCallback(() => {
    const textarea = textareaRef.current;
    const highlight = highlightRef.current;
    if (!textarea || !highlight) return;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, []);

  return (
    <div className="workspace-code-editor">
      <div
        ref={highlightRef}
        className="workspace-code-editor__highlight"
        aria-hidden
      >
        <SyntaxHighlighter
          language={language || "text"}
          style={theme}
          PreTag="pre"
          CodeTag="code"
          customStyle={{
            margin: 0,
            padding: 0,
            background: "transparent",
            fontSize: "inherit",
            lineHeight: "inherit",
            fontFamily: "inherit",
            overflow: "visible",
          }}
          codeTagProps={{
            style: {
              fontFamily: "inherit",
              fontSize: "inherit",
              lineHeight: "inherit",
            },
          }}
        >
          {value}
        </SyntaxHighlighter>
      </div>
      <textarea
        ref={textareaRef}
        className="workspace-code-editor__textarea"
        spellCheck={false}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
        onScroll={syncScroll}
        aria-label="Code editor"
      />
    </div>
  );
}
