/**
 * Lightweight markdown renderer for the mini-app embedded chat SDK.
 * Covers GFM patterns used in assistant responses (no external deps).
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInlineMarkdown(text: string): string {
  let html = escapeHtml(text);

  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/`([^`\n]+?)`/g, "<code>$1</code>");

  return html;
}

function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const [header, ...body] = rows;
  const thead = `<tr>${header.map((c) => `<th>${renderInlineMarkdown(c)}</th>`).join("")}</tr>`;
  const tbody = body
    .map(
      (row) =>
        `<tr>${row.map((c) => `<td>${renderInlineMarkdown(c)}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<table class="papr-md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\|?[\s:-]+\|[\s|:-]+\|?$/.test(line.trim());
}

export function renderMarkdownToHtml(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const fenced = normalized.split(/(```[\s\S]*?```)/g);
  const parts: string[] = [];

  for (const segment of fenced) {
    if (segment.startsWith("```") && segment.endsWith("```")) {
      const inner = segment.slice(3, -3);
      const nl = inner.indexOf("\n");
      const lang = nl >= 0 ? inner.slice(0, nl).trim() : "";
      const code = nl >= 0 ? inner.slice(nl + 1) : inner;
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      parts.push(
        `<pre class="papr-md-pre"><code${langClass}>${escapeHtml(code.trimEnd())}</code></pre>`,
      );
      continue;
    }

    const lines = segment.split("\n");
    const blocks: string[] = [];
    let listType: "ul" | "ol" | null = null;
    let tableRows: string[][] | null = null;

    const closeList = (): void => {
      if (listType) {
        blocks.push(`</${listType}>`);
        listType = null;
      }
    };

    const flushTable = (): void => {
      if (tableRows && tableRows.length > 0) {
        blocks.push(renderTable(tableRows));
        tableRows = null;
      }
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        closeList();
        flushTable();
        continue;
      }

      if (trimmed.startsWith("|") && trimmed.includes("|")) {
        closeList();
        if (i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
          flushTable();
          tableRows = [splitTableRow(trimmed)];
          i += 1;
          while (i + 1 < lines.length && lines[i + 1].trim().startsWith("|")) {
            i += 1;
            tableRows.push(splitTableRow(lines[i].trim()));
          }
          flushTable();
          continue;
        }
      }

      const ulMatch = /^[-*]\s+(.+)$/.exec(trimmed);
      if (ulMatch) {
        flushTable();
        if (listType !== "ul") {
          closeList();
          blocks.push("<ul>");
          listType = "ul";
        }
        blocks.push(`<li>${renderInlineMarkdown(ulMatch[1])}</li>`);
        continue;
      }

      const olMatch = /^(\d+)\.\s+(.+)$/.exec(trimmed);
      if (olMatch) {
        flushTable();
        if (listType !== "ol") {
          closeList();
          blocks.push("<ol>");
          listType = "ol";
        }
        blocks.push(`<li>${renderInlineMarkdown(olMatch[2])}</li>`);
        continue;
      }

      closeList();
      flushTable();

      if (trimmed.startsWith("#### ")) {
        blocks.push(`<h4>${renderInlineMarkdown(trimmed.slice(5))}</h4>`);
      } else if (trimmed.startsWith("### ")) {
        blocks.push(`<h3>${renderInlineMarkdown(trimmed.slice(4))}</h3>`);
      } else if (trimmed.startsWith("## ")) {
        blocks.push(`<h2>${renderInlineMarkdown(trimmed.slice(3))}</h2>`);
      } else if (trimmed.startsWith("# ")) {
        blocks.push(`<h1>${renderInlineMarkdown(trimmed.slice(2))}</h1>`);
      } else if (trimmed.startsWith("> ")) {
        blocks.push(
          `<blockquote>${renderInlineMarkdown(trimmed.slice(2))}</blockquote>`,
        );
      } else {
        blocks.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
      }
    }

    closeList();
    flushTable();
    parts.push(blocks.join(""));
  }

  return parts.join("");
}
