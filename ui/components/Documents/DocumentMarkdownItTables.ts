/**
 * Registers GFM-style pipe tables with tiptap-markdown's markdown-it instance.
 * Without this, `| a | b |` stays plain text and never becomes TipTap table nodes.
 */

import { Extension } from "@tiptap/core";
import type MarkdownIt from "markdown-it";
import multimdTable from "markdown-it-multimd-table";

export const DocumentMarkdownItTables = Extension.create({
  name: "documentMarkdownItTables",

  addStorage() {
    return {
      markdown: {
        parse: {
          setup(md: MarkdownIt) {
            md.use(multimdTable, {
              multiline: false,
              rowspan: false,
              headerless: false,
            });
          },
        },
      },
    };
  },
});
