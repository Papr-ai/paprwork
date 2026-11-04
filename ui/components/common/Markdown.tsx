/**
 * Markdown Component - Renders markdown with custom styling
 * Features: GFM tables, syntax-highlighted code blocks, LaTeX math (KaTeX)
 */

import React, { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { escapeNumericEmphasis } from "../../lib/markdown/escapeNumericEmphasis";
import { remarkMathGate } from "../../lib/markdown/remarkMathGate";
import { CodeBlock } from "./CodeBlock";
import { linkMentions, MENTION_HREF, MentionPill } from "./mentionPill";
import "katex/dist/katex.min.css";
import "./Markdown.css";

interface MarkdownProps {
  children: string;
  className?: string;
  /** Chat: "@Name" renders as a person pill (initials + name). */
  mentions?: boolean;
}

const components: Partial<Components> = {
  // Code blocks and inline code
  code: ({ className, children }) => (
    <CodeBlock className={className}>{children}</CodeBlock>
  ),

  // Pre tag - just a fragment, no extra styling
  pre: ({ children }) => <>{children}</>,

  // Lists
  ol: ({ children }) => <ol className="markdown-ol">{children}</ol>,
  ul: ({ children }) => <ul className="markdown-ul">{children}</ul>,
  li: ({ children }) => <li className="markdown-li">{children}</li>,

  // Strong/bold
  strong: ({ children }) => (
    <strong className="markdown-strong">{children}</strong>
  ),

  // Emphasis/italic — inherit body font so accidental mid-number emphasis stays readable
  em: ({ children }) => <em className="markdown-em">{children}</em>,

  // Links ("#mention:Name" is a person pill, from linkMentions)
  a: ({ href, children }) => href?.startsWith(MENTION_HREF) ? (
    <MentionPill name={decodeURIComponent(href.slice(MENTION_HREF.length))} />
  ) : (
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

export const Markdown: React.FC<MarkdownProps> = memo(
  ({ children, className, mentions }) => {
    const text = escapeNumericEmphasis(children?.trim() || "");
    const cleanedContent = mentions ? linkMentions(text) : text;

    return (
      <div className={`markdown-content ${className || ""}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath, remarkMathGate]}
          rehypePlugins={[
            [
              rehypeKatex,
              {
                strict: false, // Allow Unicode characters like en-dash (–)
                throwOnError: false, // Don't throw on LaTeX errors
              },
            ],
          ]}
          components={components}
        >
          {cleanedContent}
        </ReactMarkdown>
      </div>
    );
  },
);

Markdown.displayName = "Markdown";
