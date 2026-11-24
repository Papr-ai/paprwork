/**
 * StarterKit's CodeBlock with a React node view that renders ```mermaid.
 * The node keeps the name "codeBlock", so tiptap-markdown still round-trips
 * it as a fenced block — the markdown file never changes shape.
 */

import { CodeBlock } from "@tiptap/extension-code-block";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CodeBlockView } from "./CodeBlockView";

export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
});
