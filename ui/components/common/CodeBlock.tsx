/**
 * CodeBlock Component - Renders code blocks with syntax highlighting + copy button
 * Surpasses v1 which had no highlighting or copy support
 */

import React, { useState, useCallback } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import "./CodeBlock.css";

interface CodeBlockProps {
  className?: string;
  children?: React.ReactNode;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({
  className,
  children,
}) => {
  const [copied, setCopied] = useState(false);

  // Extract language from className (e.g., "language-javascript")
  const language = className?.replace("language-", "") || "";
  const rawText = React.Children.toArray(children)
    .map((child) => (typeof child === "string" ? child : ""))
    .join("");
  const hasLineBreak = rawText.includes("\n");
  const isInline = !className && !hasLineBreak;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(rawText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [rawText]);

  if (isInline) {
    return <code className="code-inline">{children}</code>;
  }

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        {language && (
          <span className="code-block-language">{language}</span>
        )}
        <button
          className="code-block-copy"
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy code"}
          type="button"
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          )}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <SyntaxHighlighter
        language={language || "text"}
        style={oneDark}
        customStyle={{
          margin: 0,
          borderRadius: "0 0 8px 8px",
          fontSize: "13px",
          lineHeight: "1.5",
        }}
        showLineNumbers={rawText.split("\n").length > 5}
      >
        {rawText.replace(/\n$/, "")}
      </SyntaxHighlighter>
    </div>
  );
};
