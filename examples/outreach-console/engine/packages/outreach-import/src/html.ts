/**
 * Inert HTML extraction with parse5: the document is only parsed into a tree. No scripts run, no
 * resources load, no CSS applies. Text inside script/style/template/noscript is ignored.
 */
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { ImportRejectedError, type RawRow } from './detect';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const SKIP = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object']);
const MAX_DEPTH = 256;

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function children(node: Node): Node[] {
  if (isElement(node) && node.tagName === 'template') return [];
  return 'childNodes' in node ? (node.childNodes as Node[]) : [];
}

function walk(node: Node, visit: (element: Element) => void, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  for (const child of children(node)) {
    if (!isElement(child)) continue;
    if (SKIP.has(child.tagName)) continue;
    visit(child);
    walk(child, visit, depth + 1);
  }
}

export function textOf(node: Node, depth = 0): string {
  if (depth > MAX_DEPTH) return '';
  if ('value' in node && node.nodeName === '#text') return node.value;
  if (isElement(node) && SKIP.has(node.tagName)) return '';
  const parts = children(node).map((child) => textOf(child, depth + 1));
  const block = isElement(node) && ['p', 'div', 'br', 'li', 'tr', 'td', 'th'].includes(node.tagName);
  return (block ? ' ' : '') + parts.join('') + (block ? ' ' : '');
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name)?.value;
}

interface SimpleSelector {
  tag?: string;
  classes: string[];
  attribute?: string;
}

/** Supports "tag", ".class", "tag.class.other", "[data-x]", combined, and descendant chains ("ul li.person"). */
export function parseSelector(selector: string): SimpleSelector[] {
  return selector.trim().split(/\s+/).map((part) => {
    const match = /^([a-z][a-z0-9-]*)?((?:\.[A-Za-z0-9_-]+)*)(?:\[([a-z][a-z0-9-]*)\])?$/.exec(part);
    if (!match) throw new ImportRejectedError(`unsupported selector "${part}"`);
    return {
      ...(match[1] ? { tag: match[1] } : {}),
      classes: (match[2] ?? '').split('.').filter(Boolean),
      ...(match[3] ? { attribute: match[3] } : {}),
    };
  });
}

function matches(element: Element, simple: SimpleSelector): boolean {
  if (simple.tag && element.tagName !== simple.tag) return false;
  const classes = (attr(element, 'class') ?? '').split(/\s+/);
  if (!simple.classes.every((c) => classes.includes(c))) return false;
  return !simple.attribute || attr(element, simple.attribute) !== undefined;
}

export function selectAll(root: Node, selector: string): Element[] {
  const chain = parseSelector(selector);
  let current: Node[] = [root];
  for (const simple of chain) {
    const next: Element[] = [];
    const seen = new Set<Element>();
    for (const scope of current) {
      walk(scope, (element) => {
        if (matches(element, simple) && !seen.has(element)) {
          seen.add(element);
          next.push(element);
        }
      });
    }
    current = next;
  }
  return current as Element[];
}

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

export function parseHtmlTable(html: string, tableIndex: number, maxRows: number): RawRow[] {
  const document = parse(html);
  const table = selectAll(document, 'table')[tableIndex];
  if (!table) throw new ImportRejectedError(`no <table> at index ${tableIndex}`);
  const rows = selectAll(table, 'tr');
  const [head, ...body] = rows;
  if (!head) return [];
  if (body.length > maxRows) throw new ImportRejectedError(`more than ${maxRows} rows`);
  const cellsOf = (row: Element) => children(row).filter(isElement).filter((c) => c.tagName === 'td' || c.tagName === 'th');
  const headers = cellsOf(head).map((cell, i) => clean(textOf(cell)) || `column_${i + 1}`);
  return body.map((row, index) => {
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    cellsOf(row).forEach((cell, i) => {
      const header = headers[i] ?? `column_${i + 1}`;
      const link = selectAll(cell, 'a')[0];
      const href = link ? attr(link, 'href') : undefined;
      values[header] = clean(textOf(cell));
      if (href && /^(mailto:|https?:)/i.test(href)) values[`${header} link`] = href;
    });
    return { locator: `html:table[${tableIndex}]/tr[${index + 1}]`, values };
  });
}

export function parseHtmlCards(html: string, cardSelector: string, fields: Readonly<Record<string, string>>, maxRows: number): RawRow[] {
  const document = parse(html);
  const cards = selectAll(document, cardSelector);
  if (cards.length > maxRows) throw new ImportRejectedError(`more than ${maxRows} rows`);
  return cards.map((card, index) => {
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [column, spec] of Object.entries(fields)) {
      const [selector, attribute] = spec.split('@');
      const target = selector?.trim() ? selectAll(card, selector)[0] : card;
      values[column] = target ? (attribute ? (attr(target, attribute) ?? '') : clean(textOf(target))) : '';
    }
    return { locator: `html:${cardSelector}[${index}]`, values };
  });
}
