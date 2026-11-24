/**
 * Code block node view. Plain code renders as before; ```mermaid blocks render
 * as a diagram that opens full-screen on click, with the source one click away.
 */

import { useEffect, useState } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { renderMermaid, type MermaidResult } from "./renderMermaid";
import { MermaidLightbox } from "./MermaidLightbox";

export function isMermaidLanguage(language: unknown): boolean {
  return typeof language === "string" && language.trim().toLowerCase() === "mermaid";
}

export function CodeBlockView({ node, editor }: ReactNodeViewProps) {
  const mermaid = isMermaidLanguage(node.attrs.language);
  const source = node.textContent;
  const [result, setResult] = useState<MermaidResult | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!mermaid) return;
    let cancelled = false;
    // Debounce so typing in the source doesn't re-render on every keystroke.
    const t = setTimeout(() => {
      renderMermaid(source).then((r) => !cancelled && setResult(r));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mermaid, source]);

  if (!mermaid) {
    return (
      <NodeViewWrapper as="pre" className="doc-code-block">
        <NodeViewContent<"code"> as="code" />
      </NodeViewWrapper>
    );
  }

  const sourceVisible = showSource || !!result?.error || !source.trim();

  return (
    <NodeViewWrapper className="doc-mermaid" data-mermaid="">
      <div className="doc-mermaid__diagram" contentEditable={false}>
        {result?.svg ? (
          <button
            type="button"
            className="doc-mermaid__preview"
            title="Open diagram"
            onClick={() => setExpanded(true)}
            dangerouslySetInnerHTML={{ __html: result.svg }}
          />
        ) : !result ? (
          <div className="doc-mermaid__loading">Rendering diagram…</div>
        ) : null}
        {result?.error && (
          <div className="doc-mermaid__error">Diagram error: {result.error}</div>
        )}
        <div className="doc-mermaid__actions">
          {result?.svg && (
            <button type="button" onClick={() => setExpanded(true)} title="Open full screen">
              ⤢ Expand
            </button>
          )}
          {editor.isEditable && (
            <button type="button" onClick={() => setShowSource((s) => !s)}>
              {sourceVisible ? "Hide source" : "Edit source"}
            </button>
          )}
        </div>
      </div>
      <pre
        className="doc-code-block doc-mermaid__source"
        hidden={!sourceVisible}
      >
        <NodeViewContent<"code"> as="code" />
      </pre>
      {expanded && result?.svg && (
        <MermaidLightbox svg={result.svg} onClose={() => setExpanded(false)} />
      )}
    </NodeViewWrapper>
  );
}
