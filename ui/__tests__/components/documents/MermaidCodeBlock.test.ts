import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Markdown } from "tiptap-markdown";
import { isMermaidLanguage } from "../../../components/Documents/mermaid/CodeBlockView";

const md = [
  "# Title",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[One] --> B{Two}",
  "```",
  "",
  "```ts",
  "const x = 1;",
  "```",
].join("\n");

describe("mermaid code blocks", () => {
  it("detects the mermaid language", () => {
    expect(isMermaidLanguage("mermaid")).toBe(true);
    expect(isMermaidLanguage(" Mermaid ")).toBe(true);
    expect(isMermaidLanguage("ts")).toBe(false);
    expect(isMermaidLanguage(null)).toBe(false);
  });

  it("round-trips ```mermaid through the editor unchanged", () => {
    // Same node config as DocumentView, minus the React node view (DOM-only).
    const editor = new Editor({
      extensions: [StarterKit.configure({ codeBlock: false }), CodeBlock, Markdown],
      content: md,
    });
    const out = (editor.storage as any).markdown.getMarkdown() as string;
    expect(out).toContain("```mermaid\nflowchart LR\n  A[One] --> B{Two}\n```");
    expect(out).toContain("```ts\nconst x = 1;\n```");
    let langs: string[] = [];
    editor.state.doc.descendants((n) => {
      if (n.type.name === "codeBlock") langs.push(n.attrs.language);
    });
    expect(langs).toEqual(["mermaid", "ts"]);
    editor.destroy();
  });
});
