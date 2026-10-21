import { parse as parseCsv } from 'csv-parse/sync';
import { ImportRejectedError, type RawRow } from './detect';

const HEADER_MAX = 200;

function cleanHeader(header: string, index: number): string {
  const name = header.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim().slice(0, HEADER_MAX);
  return name === '' ? `column_${index + 1}` : name;
}

function uniqueHeaders(headers: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header, index) => {
    const base = cleanHeader(header, index);
    const count = seen.get(base.toLowerCase()) ?? 0;
    seen.set(base.toLowerCase(), count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

/** Builds a plain record with a null prototype, so "__proto__" or "constructor" headers are just keys. */
function record(headers: readonly string[], cells: readonly unknown[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  headers.forEach((header, index) => {
    const cell = cells[index];
    out[header] = cell === undefined || cell === null ? '' : String(cell);
  });
  return out;
}

/** Strict CSV/TSV: rows are arrays (never objects keyed by untrusted headers), quotes enforced. */
export function parseDelimited(text: string, maxRows: number, delimiter?: string): RawRow[] {
  const sample = text.slice(0, 4096);
  const guessed = delimiter ?? ((sample.split('\t').length > sample.split(',').length && sample.split('\t').length > sample.split(';').length) ? '\t' : sample.split(';').length > sample.split(',').length ? ';' : ',');
  let rows: string[][];
  try {
    rows = parseCsv(text, { delimiter: guessed, bom: true, relax_column_count: true, skip_empty_lines: true, trim: false, to_line: maxRows + 2 }) as string[][];
  } catch (error) {
    throw new ImportRejectedError(`CSV could not be parsed: ${(error as Error).message.slice(0, 200)}`);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  if (body.length > maxRows) throw new ImportRejectedError(`more than ${maxRows} rows`);
  const headers = uniqueHeaders(header);
  return body.map((cells, index) => ({ locator: `csv:row=${index + 2}`, values: record(headers, cells) }));
}

function flatten(value: unknown, prefix = '', out: Record<string, string> = Object.create(null) as Record<string, string>): Record<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === '__proto__') continue;
      const name = prefix ? `${prefix}.${key}` : key;
      if (inner && typeof inner === 'object' && !Array.isArray(inner) && prefix.split('.').length < 3) flatten(inner, name, out);
      else out[name] = inner === null || inner === undefined ? '' : Array.isArray(inner) ? inner.join(', ') : String(inner);
    }
  }
  return out;
}

/** A JSON array of objects, or JSON Lines. Nested objects flatten to dotted keys (max depth 3). */
export function parseJson(text: string, maxRows: number): RawRow[] {
  const trimmed = text.trim();
  let items: unknown[];
  let locator: (i: number) => string;
  try {
    if (trimmed.startsWith('[')) {
      items = JSON.parse(trimmed) as unknown[];
      locator = (i) => `json:[${i}]`;
    } else {
      const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== '');
      items = lines.map((line) => JSON.parse(line) as unknown);
      locator = (i) => `jsonl:line=${i + 1}`;
    }
  } catch (error) {
    throw new ImportRejectedError(`JSON could not be parsed: ${(error as Error).message.slice(0, 200)}`);
  }
  if (!Array.isArray(items)) throw new ImportRejectedError('JSON must be an array of objects or JSON Lines');
  if (items.length > maxRows) throw new ImportRejectedError(`more than ${maxRows} rows`);
  return items.map((item, index) => ({ locator: locator(index), values: flatten(item) }));
}

interface XlsxCellValue {
  result?: unknown;
  formula?: unknown;
  text?: unknown;
  hyperlink?: unknown;
  richText?: { text: string }[];
  error?: unknown;
}

/** Reads cached values only. Formulas are never evaluated and external links never followed. */
function xlsxCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  const cell = value as XlsxCellValue;
  if (Array.isArray(cell.richText)) return cell.richText.map((part) => part.text).join('');
  if ('formula' in cell || 'sharedFormula' in cell) return cell.result === undefined || cell.result === null ? '' : xlsxCell(cell.result);
  if ('hyperlink' in cell) return String(cell.text ?? cell.hyperlink ?? '');
  if ('error' in cell) return '';
  return '';
}

export async function parseXlsx(bytes: Uint8Array, maxRows: number, sheetName?: string): Promise<RawRow[]> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  } catch (error) {
    throw new ImportRejectedError(`XLSX could not be read: ${(error as Error).message.slice(0, 200)}`);
  }
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!sheet) throw new ImportRejectedError(sheetName ? `sheet "${sheetName}" not found` : 'workbook has no sheets');
  if (sheet.actualRowCount > maxRows + 1) throw new ImportRejectedError(`more than ${maxRows} rows`);
  const rows: RawRow[] = [];
  let headers: string[] | null = null;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: string[] = [];
    for (let column = 1; column <= row.cellCount; column += 1) cells.push(xlsxCell(row.getCell(column).value));
    if (!headers) {
      headers = uniqueHeaders(cells);
      return;
    }
    if (cells.every((cell) => cell.trim() === '')) return;
    rows.push({ locator: `xlsx:${sheet.name}!${rowNumber}`, values: record(headers, cells) });
  });
  return rows;
}
