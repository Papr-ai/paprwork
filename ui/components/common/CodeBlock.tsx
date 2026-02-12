/**
 * CodeBlock Component - Renders code blocks and inline code
 * Based on Paprwork v1 implementation
 */

import React from "react";
import "./CodeBlock.css";

interface CodeBlockProps {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({
  inline,
  className,
  children,
}) => {
  // Extract language from className (e.g., "language-javascript")
  const language = className?.replace("language-", "") || "";

  if (inline) {
    // Inline code
    return <code className="code-inline">{children}</code>;
  }

  // Block code
  return (
    <div className="code-block-wrapper">
      {language && (
        <div className="code-block-language">{language}</div>
      )}
      <pre className="code-block-pre">
        <code className="code-block-code">{children}</code>
      </pre>
    </div>
  );
};
