/**
 * CustomMarkdown TipTap Extension
 *
 * Extends tiptap-markdown with html support and copy-text transformation.
 * Matches v1 CustomMarkdown.js behaviour.
 */

import { Markdown } from "tiptap-markdown";

export const CustomMarkdown = Markdown.extend({
  addOptions() {
    const parentOptions = this.parent?.() ?? {};
    return {
      ...parentOptions,
      html: true,
      transformCopiedText: true,
    };
  },
});
