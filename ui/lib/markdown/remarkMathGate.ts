import type { Root } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { looksLikeIntentionalLatex } from "./looksLikeIntentionalLatex";

/**
 * Downgrade accidental $...$ / $$...$$ prose to plain text before KaTeX rendering.
 */
export const remarkMathGate: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, (node, index, parent) => {
      if (parent === undefined || index === undefined) return;
      if (node.type !== "inlineMath" && node.type !== "math") return;
      if (!("value" in node) || typeof node.value !== "string") return;
      if (looksLikeIntentionalLatex(node.value)) return;

      parent.children[index] = {
        type: "text",
        value: node.value,
      };
    });
  };
};
