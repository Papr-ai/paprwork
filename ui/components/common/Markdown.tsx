/**
 * Markdown Component - Renders markdown with custom styling
 * Based on Paprwork v1 implementation using react-markdown
 */

import React, { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import "./Markdown.css";

interface MarkdownProps {
  children: string;
  className?: string;
}

const components: Partial<Components> = {
  // Code blocks and inline code
  code: CodeBlock as any,
  
  // Pre tag - just a fragment, no extra styling
  pre: ({ children }) => <>{children}</>,
  
  // Lists
  ol: ({ children }) => (
    <ol className="markdown-ol">{children}</ol>
  ),
  ul: ({ children }) => (
    <ul className="markdown-ul">{children}</ul>
  ),
  li: ({ children }) => (
    <li className="markdown-li">{children}</li>
  ),
  
  // Strong/bold
  strong: ({ children }) => (
    <strong className="markdown-strong">{children}</strong>
  ),
  
  // Links
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="markdown-link"
    >
      {children}
    </a>
  ),
  
  // Headings
  h1: ({ children }) => <h1 className="markdown-h1">{children}</h1>,
  h2: ({ children }) => <h2 className="markdown-h2">{children}</h2>,
  h3: ({ children }) => <h3 className="markdown-h3">{children}</h3>,
  h4: ({ children }) => <h4 className="markdown-h4">{children}</h4>,
  h5: ({ children }) => <h5 className="markdown-h5">{children}</h5>,
  h6: ({ children }) => <h6 className="markdown-h6">{children}</h6>,
  
  // Paragraphs
  p: ({ children }) => <p className="markdown-p">{children}</p>,
  
  // Blockquotes
  blockquote: ({ children }) => (
    <blockquote className="markdown-blockquote">{children}</blockquote>
  ),
};

export const Markdown: React.FC<MarkdownProps> = memo(({ children, className }) => {
  // Clean content: trim whitespace and normalize newlines
  const cleanedContent = children?.trim() || "";
  
  return (
    <div className={`markdown-content ${className || ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {cleanedContent}
      </ReactMarkdown>
    </div>
  );
});

Markdown.displayName = "Markdown";
